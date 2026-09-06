import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import { copyCliRuntime } from "@t3tools/shared/cliRuntime";
import { normalizeHostedAppUrl } from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { loadRepoEnv, resolvePublicConfig } from "./lib/public-config.ts";
import type { T3CodePublicConfig } from "./lib/public-config.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function inspect(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

async function isOwnedDirectory(directory: string, home: string): Promise<boolean> {
  let canonicalHome: string;
  try {
    canonicalHome = await realpath(home);
  } catch {
    return false;
  }
  // Resolve the nearest existing ancestor so missing directories (first
  // install) still verify against a real on-disk target instead of a lexical
  // path. Anything that cannot be resolved to a real target is not owned.
  let ancestor = directory;
  const rest: string[] = [];
  let canonicalAncestor: string | undefined;
  while (true) {
    try {
      canonicalAncestor = await realpath(ancestor);
      break;
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") {
        return false;
      }
      // A dangling symlink is not a missing directory that we can safely create.
      try {
        if (await inspect(ancestor)) return false;
      } catch {
        return false;
      }
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return false;
    rest.unshift(basename(ancestor));
    ancestor = parent;
  }
  const canonicalDir = join(canonicalAncestor, ...rest);
  const fromHome = relative(canonicalHome, join(canonicalDir, "t3"));
  if (fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) return false;
  // Lexical containment is not enough: a symlinked bin directory can still
  // resolve outside the home directory, so require matching ownership of the
  // real target as well. Unverifiable entries fail closed.
  try {
    const [dirStat, homeStat] = await Promise.all([stat(canonicalAncestor), stat(canonicalHome)]);
    if ("uid" in dirStat && "uid" in homeStat && dirStat.uid !== homeStat.uid) return false;
  } catch {
    return false;
  }
  return true;
}

export async function resolveCliLink(path: string, home: string): Promise<string> {
  let available: string | undefined;
  for (const directory of path.split(delimiter)) {
    // pnpm injects workspace bin directories ahead of the user's shell PATH.
    if (!isAbsolute(directory) || directory.split(sep).includes("node_modules")) continue;
    const candidate = join(directory, "t3");
    const ownedPath = await isOwnedDirectory(directory, home);
    if (ownedPath) available ??= candidate;
    let existing: Awaited<ReturnType<typeof inspect>>;
    try {
      existing = await inspect(candidate);
    } catch (cause) {
      if (!ownedPath) continue;
      throw cause;
    }
    if (!existing) continue;
    if (!ownedPath || !existing.isSymbolicLink()) {
      throw new Error(
        `Refusing to replace ${candidate}: expected a user-owned symlink. Remove or relocate that installation explicitly, then retry.`,
      );
    }
    return candidate;
  }
  if (available) return available;
  throw new Error(
    "Add ~/.local/bin to PATH, then retry. No user-owned bin directory is present on PATH.",
  );
}

export async function installCliPackage(source: string, installations: string, link: string) {
  // Serialize validation and activation across cooperating installers: the
  // pre-activation ownership check below is only meaningful while no other
  // installer can replace `link` before `rename`.
  // Create the parent first so first installs (missing PATH directory) can
  // acquire the sibling lock instead of failing with ENOENT; the same
  // recursive mkdir inside the lock stays idempotent.
  await mkdir(dirname(link), { recursive: true });
  const lockDir = `${link}.install.lock`;
  try {
    await mkdir(lockDir);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") {
      throw new Error(
        `Another CLI installation is in progress for ${link}; wait for it to finish, or remove ${lockDir} if it is stale, then retry.`,
        { cause },
      );
    }
    throw cause;
  }
  try {
    return await installCliPackageLocked(source, installations, link);
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function installCliPackageLocked(source: string, installations: string, link: string) {
  const original = await inspect(link);
  if (original && !original.isSymbolicLink()) throw new Error(`Refusing to overwrite ${link}.`);
  await mkdir(dirname(link), { recursive: true });
  await mkdir(installations, { recursive: true, mode: 0o700 });
  const destination = await mkdtemp(join(installations, "cli-"));
  const entry = join(destination, "dist", "bin.mjs");
  const candidateLink = `${link}.${randomUUID()}.candidate`;
  let activated = false;
  try {
    await copyCliRuntime(join(source, "dist"), join(destination, "dist"));
    // Keep a normal package layout so service install can snapshot this installation again.
    await rename(join(destination, "dist", "node_modules"), join(destination, "node_modules"));
    await copyFile(join(source, "package.json"), join(destination, "package.json"));
    await chmod(entry, 0o755);
    execFileSync(process.execPath, [entry, "--help"], { stdio: "pipe" });
    const current = await inspect(link);
    if (current?.ino !== original?.ino || current?.dev !== original?.dev) {
      throw new Error(`${link} changed during installation; leaving the new owner untouched.`);
    }
    await symlink(entry, candidateLink);
    await rename(candidateLink, link);
    activated = true;
    return entry;
  } finally {
    await rm(candidateLink, { force: true });
    if (!activated) await rm(destination, { recursive: true, force: true });
  }
}

export async function waitForConnect(
  readStatus: () => string,
  wait: () => Promise<unknown> = () => sleep(2_000),
) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status: unknown = JSON.parse(readStatus());
    if (typeof status !== "object" || status === null || !("state" in status)) {
      throw new Error("The installed CLI returned an invalid Connect status.");
    }
    if (status.state === "linked-online") return;
    if (status.state !== "linked-offline" && status.state !== "link-pending") {
      throw new Error(
        "Connect setup is incomplete. Finish account authorization and background setup.",
      );
    }
    await wait();
  }
  throw new Error(
    "The CLI is installed, but Connect did not come online. Run `t3 service status` and `t3 connect status` with the same --base-dir for details.",
  );
}

export function assertConnectConfig(
  config: Pick<T3CodePublicConfig, "relayUrl" | "clerkPublishableKey" | "hostedAppUrl">,
): void {
  // Mirror the runtime validators so an invalid deployment fails before the
  // build, not after an unusable candidate has been activated.
  if (normalizeSecureRelayUrl(config.relayUrl ?? "") === null) {
    throw new Error(
      "Invalid T3CODE_RELAY_URL: expected a secure absolute HTTPS origin (no path, query, or fragment).",
    );
  }
  try {
    clerkFrontendApiUrlFromPublishableKey(config.clerkPublishableKey ?? "");
  } catch {
    throw new Error(
      "Invalid T3CODE_CLERK_PUBLISHABLE_KEY: the CLI cannot derive a Clerk Frontend API URL from it.",
    );
  }
  assertHostedAppUrl(config.hostedAppUrl);
}

function assertHostedAppUrl(value: string | undefined): void {
  const hosted = value?.trim();
  // Unset falls back to the default hosted app at runtime; only validate an
  // explicit override with the same rule as hostedAppUrlConfig, which login
  // enforces before opening the authorization page.
  if (!hosted) return;
  if (normalizeHostedAppUrl(hosted) === null) {
    throw new Error(
      "Invalid T3CODE_HOSTED_APP_URL: expected an absolute HTTPS origin (or HTTP loopback origin) with no path, query, or fragment.",
    );
  }
}

export function resolveInstallEnv(
  baseEnv: Record<string, string | undefined> = loadRepoEnv({ includeExample: true }),
): NodeJS.ProcessEnv {
  // Normalize once so the build and Connect setup resolve identical values;
  // deployments configured only in repo env files must not diverge at setup.
  return toProcessEnv({
    ...baseEnv,
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
  });
}

function toProcessEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function main() {
  const { values } = parseArgs({
    options: {
      connect: { type: "boolean", default: false },
      "base-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("Usage: pnpm install:t3:cli [--connect] [--base-dir PATH]");
    return;
  }
  if (process.platform !== "darwin") throw new Error("This installer currently supports macOS.");
  const home = homedir();
  const link = await resolveCliLink(process.env.PATH ?? "", home);
  const env = resolveInstallEnv();
  const config = resolvePublicConfig(env);
  if (!config.relayUrl || !config.clerkPublishableKey || !config.clerkCliOAuthClientId) {
    throw new Error("Configure the complete public Connect deployment before building the CLI.");
  }
  assertConnectConfig(config);
  for (const name of ["@t3tools/web", "t3"]) {
    execFileSync("pnpm", ["--filter", name, "build"], { cwd: repoRoot, env, stdio: "inherit" });
  }
  const entry = await installCliPackage(
    join(repoRoot, "apps", "server"),
    join(home, ".local", "share", "t3"),
    link,
  );
  console.log(
    `Installed the rebuilt CLI at ${link}. Existing data and account links are unchanged.`,
  );
  if (values.connect) {
    const baseDir = resolve(values["base-dir"] ?? process.env.T3CODE_HOME ?? join(home, ".t3"));
    // Run setup with the same normalized build environment so deployments
    // configured only in repo env files resolve identically at setup time.
    execFileSync(process.execPath, [entry, "connect", "--base-dir", baseDir], {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    });
    await waitForConnect(() =>
      execFileSync(
        process.execPath,
        [entry, "connect", "status", "--base-dir", baseDir, "--json"],
        { encoding: "utf8", timeout: 10_000, env },
      ),
    );
    console.log(
      "T3 Connect is linked and online. Sign into the same account on your other device.",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
