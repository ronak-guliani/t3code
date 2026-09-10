import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverLocalEnvironments,
  inspectLocalEnvironment,
  localSelectionPath,
  readLocalEnvironmentSelection,
  resolveDefaultLocalBaseDir,
  selectLocalEnvironment,
} from "./localEnvironment.ts";

let home: string;
async function environment(name = ".t3-rg", id = "test-environment") {
  const dir = join(home, name);
  await mkdir(join(dir, "userdata"), { recursive: true });
  await writeFile(join(dir, "userdata", "environment-id"), id);
  return dir;
}
async function runtime(dir: string, origin: string, pid = process.pid) {
  await writeFile(
    join(dir, "userdata", "server-runtime.json"),
    JSON.stringify({
      version: 1,
      pid,
      origin,
      startedAt: new Date().toISOString(),
    }),
  );
}
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "t3-local-test-")));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(home, { recursive: true, force: true });
});

describe("local environment discovery and default", () => {
  it("preserves the legacy default when no environment exists and ignores dev homes", async () => {
    expect(await resolveDefaultLocalBaseDir(home)).toBe(join(home, ".t3"));
    await environment(".t3-dev");
    expect(await resolveDefaultLocalBaseDir(home)).toBe(join(home, ".t3"));
  });
  it("requires an explicit choice before accidentally creating another environment", async () => {
    const dir = await environment();
    await expect(resolveDefaultLocalBaseDir(home)).rejects.toThrow("existing local environment");
    await selectLocalEnvironment(dir, home);
    expect(await resolveDefaultLocalBaseDir(home)).toBe(dir);
    expect(JSON.parse(await readFile(localSelectionPath(home), "utf8"))).toMatchObject({
      version: 1,
      baseDir: dir,
      environmentId: "test-environment",
    });
  });
  it("never falls back when the selected identity is missing or changes", async () => {
    const dir = await environment();
    await selectLocalEnvironment(dir, home);
    await writeFile(join(dir, "userdata", "environment-id"), "replacement");
    await expect(resolveDefaultLocalBaseDir(home)).rejects.toThrow("no fallback");
    await rm(join(dir, "userdata", "environment-id"));
    await expect(readLocalEnvironmentSelection(home)).rejects.toThrow("no fallback");
  });
  it("rejects relative selection files and project directories", async () => {
    await expect(selectLocalEnvironment(home, home)).rejects.toThrow("not a project directory");
    await mkdir(join(home, ".config", "t3"), { recursive: true });
    await writeFile(
      localSelectionPath(home),
      JSON.stringify({ version: 1, baseDir: "relative", environmentId: "test" }),
    );
    await expect(readLocalEnvironmentSelection(home)).rejects.toThrow("not absolute");
  });
  it("bounds discovery and canonicalizes duplicate paths", async () => {
    const dir = await environment();
    await environment("arbitrary-project");
    const alias = join(home, "alias");
    await symlink(dir, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await discoverLocalEnvironments([alias, dir], home)).toMatchObject([
      { baseDir: dir, status: "offline", environmentId: "test-environment" },
    ]);
  });
  it("does not treat an alive but unreachable process as offline", async () => {
    const dir = await environment();
    await runtime(dir, "http://127.0.0.1:13773");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));
    expect(await inspectLocalEnvironment(dir)).toMatchObject({
      status: "unavailable",
      error: "Connection refused",
      pid: process.pid,
      origin: "http://127.0.0.1:13773",
      startedAt: expect.any(String),
    });
  });
  it.each([
    "http://example.com",
    "https://127.0.0.1",
    "http://user:secret@127.0.0.1",
    "http://127.0.0.1/path",
  ])("rejects a noncanonical or nonloopback runtime origin %s", async (origin) => {
    const dir = await environment();
    await runtime(dir, origin);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await inspectLocalEnvironment(dir)).toMatchObject({
      status: "unavailable",
      pid: process.pid,
      origin: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects malformed runtime files instead of launching a second server", async () => {
    const dir = await environment();
    await writeFile(join(dir, "userdata", "server-runtime.json"), "{");
    expect(await inspectLocalEnvironment(dir)).toMatchObject({ status: "unavailable" });
  });
});
