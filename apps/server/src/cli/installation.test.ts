import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRuntimeOwnership, installationIdentity, supportedNode } from "./installation.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("installation identity and prerequisites", () => {
  it("distinguishes this fork and the actual runtime", () => {
    expect(installationIdentity()).toMatchObject({
      distribution: "ronak-guliani/t3code",
      executable: process.execPath,
      arch: process.arch,
      node: process.versions.node,
    });
  });
  it("enforces the packaged distribution's Node range", () => {
    for (const version of ["24.13.1", "24.13.2", "24.14.0"])
      expect(supportedNode(version)).toBe(true);
    for (const version of ["24.13.0", "24.12.9", "22.16.0", "25.0.0", "invalid"])
      expect(supportedNode(version)).toBe(false);
  });
  it("reports the owner without probing or killing a process", async () => {
    const base = await mkdtemp(join(tmpdir(), "t3-owner-"));
    directories.push(base);
    expect(await inspectRuntimeOwnership(base)).toMatchObject({ state: "stopped", owner: "none" });
    await mkdir(join(base, "userdata"));
    await writeFile(
      join(base, "userdata", "server-runtime.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        origin: "http://127.0.0.1:1",
        startedAt: new Date().toISOString(),
        owner: "foreground",
      }),
    );
    expect(await inspectRuntimeOwnership(base)).toMatchObject({
      state: "running",
      owner: "foreground",
      pid: process.pid,
    });
    await writeFile(join(base, "userdata", "server-runtime.json"), "{}");
    await expect(inspectRuntimeOwnership(base)).rejects.toThrow("Cannot verify runtime ownership");
  });
});
