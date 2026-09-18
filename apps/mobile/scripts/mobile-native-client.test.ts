import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  checkVariant,
  ensureVariant,
  manifestUrlFor,
  parseArgs,
  rebuiltStatus,
} from "./mobile-native-client.mts";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const projectRoot = "/test/mobile";
const udid = "UDID-1";
const fingerprint = "fingerprint-abc";

const stamp = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    variant: "development",
    bundleId: "com.ronakguliani.t3code.dev",
    fingerprint,
    udid,
    installedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  });

const mockProcesses = (
  options: {
    fingerprintOutput?: string;
    installed?: boolean;
    runStatus?: number;
    launchFails?: boolean;
  } = {},
) => {
  const spawns: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
  const execs: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(execFileSync).mockImplementation(((cmd: string, args: ReadonlyArray<string>) => {
    execs.push({ cmd, args: [...args] });
    if (args.includes("fingerprint:generate")) {
      return options.fingerprintOutput ?? JSON.stringify({ hash: fingerprint });
    }
    if (args.includes("openurl") && options.launchFails === true) {
      throw new Error("simctl openurl failed");
    }
    return "";
  }) as typeof execFileSync);
  vi.mocked(spawnSync).mockImplementation(((cmd: string, args: ReadonlyArray<string>) => {
    spawns.push({ cmd, args: [...args] });
    if (args.includes("get_app_container")) {
      return { status: options.installed === false ? 1 : 0 };
    }
    if (args.includes("run:ios")) {
      return { status: options.runStatus ?? 0 };
    }
    return { status: 0 };
  }) as typeof spawnSync);
  return { spawns, execs };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mobile-native-client args", () => {
  it("defaults to check development with launch", () => {
    expect(parseArgs(["check"])).toMatchObject({ command: "check", variant: "development" });
    expect(parseArgs(["ensure"])).toMatchObject({ command: "ensure", launch: true });
  });

  it("parses variant, udid, manifest override, and no-launch", () => {
    expect(
      parseArgs([
        "ensure",
        "--variant",
        "preview",
        "--udid",
        udid,
        "--manifest-url",
        "custom://launch",
        "--no-launch",
        "--project-root",
        projectRoot,
      ]),
    ).toEqual({
      command: "ensure",
      variant: "preview",
      udid,
      manifestUrl: "custom://launch",
      launch: false,
      projectRoot,
    });
  });

  it("rejects unknown commands, variants, and options", () => {
    expect(() => parseArgs(["check", "--variant"])).toThrow("Missing value");
    expect(() => parseArgs(["build"])).toThrow("Usage");
    expect(() => parseArgs(["check", "--variant", "production"])).toThrow("--variant");
    expect(() => parseArgs(["check", "--rebuild"])).toThrow("Unknown option");
  });

  it("rejects missing option values instead of surfacing them later", () => {
    expect(() => parseArgs(["check", "--udid"])).toThrow("Missing value for --udid");
    expect(() => parseArgs(["check", "--udid", "--no-launch"])).toThrow("Missing value for --udid");
    expect(() => parseArgs(["ensure", "--manifest-url"])).toThrow(
      "Missing value for --manifest-url",
    );
    expect(() => parseArgs(["ensure", "--project-root"])).toThrow(
      "Missing value for --project-root",
    );
  });
});

describe("mobile-native-client manifest urls", () => {
  it("uses the proven generated scheme for development", () => {
    expect(manifestUrlFor("development", undefined)).toContain("exp+t3-code-rg://");
  });

  it("uses the registered custom scheme for preview", () => {
    const url = manifestUrlFor("preview", undefined);
    expect(url).toContain("t3code-rg-preview://");
    expect(url).not.toContain("exp+");
  });

  it("honors an explicit override", () => {
    expect(manifestUrlFor("preview", "custom://launch")).toBe("custom://launch");
  });
});

describe("mobile-native-client check", () => {
  it("reports fresh when the installed stamp matches", () => {
    mockProcesses();
    vi.mocked(readFileSync).mockReturnValue(stamp());
    const result = checkVariant(projectRoot, "development", udid);
    expect(result).toMatchObject({
      fresh: true,
      installed: true,
      fingerprintMatch: true,
      reason: "fresh",
    });
  });

  it("reports missing-app when the bundle is not installed", () => {
    mockProcesses({ installed: false });
    const result = checkVariant(projectRoot, "development", udid);
    expect(result).toMatchObject({ fresh: false, installed: false, reason: "missing-app" });
  });

  it("reports native-dirty on fingerprint mismatch", () => {
    mockProcesses();
    vi.mocked(readFileSync).mockReturnValue(stamp({ fingerprint: "stale" }));
    const result = checkVariant(projectRoot, "development", udid);
    expect(result).toMatchObject({ fresh: false, reason: "native-dirty" });
  });

  it("falls back to hashing raw fingerprint output", () => {
    mockProcesses({ fingerprintOutput: "not json" });
    vi.mocked(readFileSync).mockReturnValue(stamp({ fingerprint: "raw:x" }));
    const result = checkVariant(projectRoot, "development", udid);
    expect(result.currentFingerprint.startsWith("raw:")).toBe(true);
    expect(result.fresh).toBe(false);
  });
});

describe("mobile-native-client ensure", () => {
  it("skips the rebuild when fresh and relaunches the variant client", () => {
    const { spawns, execs } = mockProcesses();
    vi.mocked(readFileSync).mockReturnValue(stamp());
    const result = ensureVariant(
      projectRoot,
      "development",
      udid,
      manifestUrlFor("development", undefined),
      true,
    );
    expect(result.action).toBe("skipped");
    expect(result.fresh).toBe(true);
    const commands = spawns.map((call) => call.args.join(" "));
    expect(commands.some((args) => args.includes("prebuild"))).toBe(false);
    expect(commands.some((args) => args.includes("run:ios"))).toBe(false);
    const openurl = execs.find((call) => call.args.includes("openurl"));
    const terminate = execs.find((call) => call.args.includes("terminate"));
    expect(terminate?.args).toContain("com.ronakguliani.t3code.dev");
    expect(openurl?.args.join(" ")).toContain("exp+t3-code-rg://");
  });

  it("launches the preview client through its registered scheme", () => {
    const { execs } = mockProcesses();
    vi.mocked(readFileSync).mockReturnValue(
      stamp({
        variant: "preview",
        bundleId: "com.ronakguliani.t3code.preview",
      }),
    );
    ensureVariant(projectRoot, "preview", udid, manifestUrlFor("preview", undefined), true);
    const openurl = execs.find((call) => call.args.includes("openurl"));
    const terminate = execs.find((call) => call.args.includes("terminate"));
    expect(terminate?.args).toContain("com.ronakguliani.t3code.preview");
    expect(openurl?.args.join(" ")).toContain("t3code-rg-preview://");
  });

  it("rebuilds when stale and returns a consistent fresh status", () => {
    const { spawns } = mockProcesses({ installed: false });
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("no stamp"), { code: "ENOENT" });
    });
    const result = ensureVariant(
      projectRoot,
      "development",
      udid,
      manifestUrlFor("development", undefined),
      true,
    );
    const commands = spawns.map((call) => call.args.join(" "));
    expect(commands.some((args) => args.includes("ios-preflight.mts"))).toBe(true);
    expect(commands.some((args) => args.includes("prebuild"))).toBe(true);
    expect(commands.some((args) => args.includes("run:ios"))).toBe(true);
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce();
    const [stampPath, stampBody] = vi.mocked(writeFileSync).mock.calls[0] as [string, string];
    expect(stampPath).toContain(".native-fingerprint-development.json");
    expect(JSON.parse(stampBody)).toMatchObject({ fingerprint, udid });
    expect(vi.mocked(mkdirSync)).toHaveBeenCalled();
    // No contradictory pre-build fields: a successful rebuild is fresh.
    expect(result).toMatchObject({
      action: "rebuilt",
      fresh: true,
      installed: true,
      fingerprintMatch: true,
      reason: "fresh",
      storedFingerprint: fingerprint,
    });
  });

  it("does not launch with --no-launch", () => {
    const { execs } = mockProcesses();
    vi.mocked(readFileSync).mockReturnValue(stamp());
    ensureVariant(
      projectRoot,
      "development",
      udid,
      manifestUrlFor("development", undefined),
      false,
    );
    expect(execs.some((call) => call.args.includes("openurl"))).toBe(false);
  });

  it("fails without writing a stamp when the install fails", () => {
    mockProcesses({ installed: false, runStatus: 1 });
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("no stamp"), { code: "ENOENT" });
    });
    expect(() =>
      ensureVariant(
        projectRoot,
        "development",
        udid,
        manifestUrlFor("development", undefined),
        true,
      ),
    ).toThrow("run:ios");
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  it("keeps the fresh stamp when the post-build Metro launch fails", () => {
    mockProcesses({ installed: false, launchFails: true });
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("no stamp"), { code: "ENOENT" });
    });
    expect(() =>
      ensureVariant(
        projectRoot,
        "development",
        udid,
        manifestUrlFor("development", undefined),
        true,
      ),
    ).toThrow("could not point it at Metro");
    // The native install succeeded, so the stamp stays: the next ensure
    // relaunches instead of rebuilding.
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce();
  });

  it("surfaces a relaunchable error when the fresh-path launch fails", () => {
    const { spawns } = mockProcesses({ launchFails: true });
    vi.mocked(readFileSync).mockReturnValue(stamp());
    expect(() =>
      ensureVariant(
        projectRoot,
        "development",
        udid,
        manifestUrlFor("development", undefined),
        true,
      ),
    ).toThrow("could not point it at Metro");
    const commands = spawns.map((call) => call.args.join(" "));
    expect(commands.some((args) => args.includes("prebuild"))).toBe(false);
  });
});

describe("mobile-native-client rebuiltStatus", () => {
  it("resolves contradictory pre-build fields to fresh", () => {
    expect(
      rebuiltStatus({
        fresh: false,
        installed: false,
        fingerprintMatch: false,
        reason: "missing-app",
        variant: "development",
        bundleId: "com.ronakguliani.t3code.dev",
        udid,
        currentFingerprint: fingerprint,
      }),
    ).toMatchObject({
      fresh: true,
      installed: true,
      fingerprintMatch: true,
      reason: "fresh",
      storedFingerprint: fingerprint,
    });
  });
});
