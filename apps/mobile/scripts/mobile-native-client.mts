#!/usr/bin/env node
/**
 * mobile-native-client - verify the iOS simulator's installed dev client
 * matches the checkout's native fingerprint, rebuilding only when needed.
 *
 * Usage:
 *   node mobile-native-client.mts check [--variant development] [--udid $T3_SIM_UDID]
 *   node mobile-native-client.mts ensure [--variant development] [--udid $T3_SIM_UDID] [--no-launch]
 *
 * `check` prints JSON { fresh, installed, fingerprintMatch, ... } and always
 * exits 0 when the simulator itself is reachable. `ensure` rebuilds and
 * reinstalls only when stale, then points the client at Metro; JS-only
 * changes never trigger a rebuild (see references/captures.md).
 *
 * The stamp lives under apps/mobile/ios/ (gitignored): the simulator cannot
 * report its own fingerprint, so the last successful install's fingerprint is
 * the source of truth. Never commit the stamp or ios/ output.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const VARIANTS = {
  development: {
    bundleId: "com.ronakguliani.t3code.dev",
    scheme: "t3code-rg-dev",
    // Proven manifest URL from the test-t3-mobile skill references. This uses
    // the generated exp+ scheme, which expo-dev-client registers for
    // development only (app.config.ts addGeneratedScheme).
    manifestUrl: "exp+t3-code-rg://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081%2F",
  },
  preview: {
    bundleId: "com.ronakguliani.t3code.preview",
    scheme: "t3code-rg-preview",
    // Non-development builds omit the generated exp+ scheme, so launch via
    // the variant's registered custom scheme instead.
    manifestUrl:
      "t3code-rg-preview://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081%2F",
  },
} as const;
type Variant = keyof typeof VARIANTS;
type Reason = "fresh" | "missing-app" | "no-stamp" | "device-changed" | "native-dirty";

interface CheckResult {
  readonly fresh: boolean;
  readonly installed: boolean;
  readonly fingerprintMatch: boolean;
  readonly reason: Reason;
  readonly variant: Variant;
  readonly bundleId: string;
  readonly udid: string;
  readonly currentFingerprint: string;
  readonly storedFingerprint?: string | undefined;
}

interface Stamp {
  readonly version: 1;
  readonly variant: Variant;
  readonly bundleId: string;
  readonly fingerprint: string;
  readonly udid: string;
  readonly installedAt: string;
}

const here = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Could not locate the repository root.");
    dir = parent;
  }
}

export function manifestUrlFor(variant: Variant, override: string | undefined): string {
  return override ?? VARIANTS[variant].manifestUrl;
}

export function parseArgs(argv: ReadonlyArray<string>): {
  command: "check" | "ensure";
  variant: Variant;
  udid: string | undefined;
  manifestUrl: string | undefined;
  launch: boolean;
  projectRoot: string | undefined;
} {
  const [command, ...rest] = argv;
  if (command !== "check" && command !== "ensure") {
    throw new Error("Usage: mobile-native-client.mts <check|ensure> [options]");
  }
  let variant: Variant = "development";
  let udid: string | undefined;
  let manifestUrl: string | undefined;
  let launch = true;
  let projectRoot: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--variant") {
      const value = rest[++i];
      if (value !== "development" && value !== "preview") {
        throw new Error(`Unknown --variant: ${value}. Use development or preview.`);
      }
      variant = value;
    } else if (arg === "--udid") {
      udid = rest[++i];
    } else if (arg === "--manifest-url") {
      manifestUrl = rest[++i];
    } else if (arg === "--no-launch") {
      launch = false;
    } else if (arg === "--project-root") {
      projectRoot = rest[++i];
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { command, variant, udid, manifestUrl, launch, projectRoot };
}

function runQuiet(cmd: string, args: ReadonlyArray<string>, cwd: string, env = {}): string {
  return execFileSync(cmd, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

function expoBin(projectRoot: string): { cmd: string; argsPrefix: ReadonlyArray<string> } {
  const local = join(projectRoot, "node_modules", ".bin", "expo");
  if (existsSync(local)) return { cmd: local, argsPrefix: [] };
  return { cmd: "expo", argsPrefix: [] };
}

/** Expo fingerprint for the variant, including variant-specific config. */
function currentFingerprint(projectRoot: string, variant: Variant): string {
  const { cmd } = expoBin(projectRoot);
  const env = { APP_VARIANT: variant, EXPO_NO_GIT_STATUS: "1" };
  try {
    const output = runQuiet(cmd, ["fingerprint:generate", "--platform", "ios"], projectRoot, env);
    try {
      const parsed = JSON.parse(output) as { hash?: unknown };
      if (typeof parsed.hash === "string" && parsed.hash.length > 0) return parsed.hash;
    } catch {
      // Fall through to hashing the raw output below.
    }
    return `raw:${createHash("sha256").update(output).digest("hex")}`;
  } catch (error) {
    throw new Error(
      `Could not compute the Expo fingerprint. Is expo installed for apps/mobile? ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function stampPath(projectRoot: string, variant: Variant): string {
  return join(projectRoot, "ios", `.native-fingerprint-${variant}.json`);
}

export function readStamp(path: string): Stamp | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Stamp>;
    if (
      parsed.version === 1 &&
      typeof parsed.fingerprint === "string" &&
      typeof parsed.udid === "string" &&
      typeof parsed.bundleId === "string"
    ) {
      return parsed as Stamp;
    }
    return null;
  } catch {
    return null;
  }
}

function isInstalled(udid: string, bundleId: string): boolean {
  const result = spawnSync("xcrun", ["simctl", "get_app_container", udid, bundleId], {
    stdio: "ignore",
  });
  return result.status === 0;
}

export function checkVariant(projectRoot: string, variant: Variant, udid: string): CheckResult {
  const { bundleId } = VARIANTS[variant];
  const fingerprint = currentFingerprint(projectRoot, variant);
  const installed = isInstalled(udid, bundleId);
  if (!installed) {
    return {
      fresh: false,
      installed,
      fingerprintMatch: false,
      reason: "missing-app",
      variant,
      bundleId,
      udid,
      currentFingerprint: fingerprint,
    };
  }
  const stamp = readStamp(stampPath(projectRoot, variant));
  if (!stamp) {
    return {
      fresh: false,
      installed,
      fingerprintMatch: false,
      reason: "no-stamp",
      variant,
      bundleId,
      udid,
      currentFingerprint: fingerprint,
    };
  }
  if (stamp.udid !== udid) {
    return {
      fresh: false,
      installed,
      fingerprintMatch: stamp.fingerprint === fingerprint,
      reason: "device-changed",
      variant,
      bundleId,
      udid,
      currentFingerprint: fingerprint,
      storedFingerprint: stamp.fingerprint,
    };
  }
  const match = stamp.fingerprint === fingerprint && stamp.bundleId === bundleId;
  return {
    fresh: match,
    installed,
    fingerprintMatch: match,
    reason: match ? "fresh" : "native-dirty",
    variant,
    bundleId,
    udid,
    currentFingerprint: fingerprint,
    storedFingerprint: stamp.fingerprint,
  };
}

function runInherited(cmd: string, args: ReadonlyArray<string>, cwd: string, env = {}): void {
  const result = spawnSync(cmd, [...args], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(" ")}`);
  }
}

function pointAtMetro(udid: string, bundleId: string, manifestUrl: string): void {
  try {
    execFileSync("xcrun", ["simctl", "terminate", udid, bundleId], {
      stdio: "ignore",
    });
  } catch {
    // Cold client; openurl below launches it.
  }
  execFileSync("xcrun", ["simctl", "openurl", udid, manifestUrl], { stdio: "ignore" });
}

/**
 * Status after a successful rebuild/install: the stamp was just written with
 * the current fingerprint for this device, so every field must describe the
 * fresh state rather than the pre-build check that triggered the rebuild.
 */
export function rebuiltStatus(checked: CheckResult): CheckResult {
  return {
    ...checked,
    fresh: true,
    installed: true,
    fingerprintMatch: true,
    reason: "fresh",
    storedFingerprint: checked.currentFingerprint,
  };
}

export function ensureVariant(
  projectRoot: string,
  variant: Variant,
  udid: string,
  manifestUrl: string,
  launch: boolean,
): CheckResult & { action: "skipped" | "rebuilt" } {
  const checked = checkVariant(projectRoot, variant, udid);
  if (checked.fresh) {
    if (launch) pointAtMetro(udid, VARIANTS[variant].bundleId, manifestUrl);
    return { ...checked, action: "skipped" };
  }
  runInherited("node", [join(projectRoot, "scripts", "ios-preflight.mts")], projectRoot);
  const { cmd } = expoBin(projectRoot);
  const env = { APP_VARIANT: variant, EXPO_NO_GIT_STATUS: "1" };
  runInherited(cmd, ["prebuild", "--clean", "--platform", "ios"], projectRoot, env);
  runInherited(cmd, ["run:ios", "--no-bundler", "--device", udid], projectRoot, env);
  const stamp: Stamp = {
    version: 1,
    variant,
    bundleId: VARIANTS[variant].bundleId,
    fingerprint: checked.currentFingerprint,
    udid,
    installedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(stampPath(projectRoot, variant)), { recursive: true });
  writeFileSync(stampPath(projectRoot, variant), `${JSON.stringify(stamp, null, 2)}\n`);
  if (launch) pointAtMetro(udid, VARIANTS[variant].bundleId, manifestUrl);
  return { ...rebuiltStatus(checked), action: "rebuilt" };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const repoRoot = findRepoRoot(here);
    const projectRoot = args.projectRoot ?? join(repoRoot, "apps", "mobile");
    const udid = args.udid ?? process.env["T3_SIM_UDID"];
    if (!udid) {
      throw new Error("No simulator UDID: pass --udid or source maestro-env.sh (T3_SIM_UDID).");
    }
    execFileSync("xcrun", ["simctl", "bootstatus", udid, "-b"], { stdio: "ignore" });
    const manifestUrl = manifestUrlFor(args.variant, args.manifestUrl);
    const result =
      args.command === "check"
        ? checkVariant(projectRoot, args.variant, udid)
        : ensureVariant(projectRoot, args.variant, udid, manifestUrl, args.launch);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      `mobile-native-client: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
