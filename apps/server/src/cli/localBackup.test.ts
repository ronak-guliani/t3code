import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { backupLocalEnvironment, restoreLocalEnvironment } from "./localBackup.ts";

let home: string;
let source: string;
let archive: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "t3-backup-test-")));
  source = join(home, "environment");
  archive = join(home, "backup");
  await mkdir(join(source, "userdata"), { recursive: true });
  await writeFile(join(source, "userdata", "environment-id"), "test-environment");
  await writeFile(join(source, "userdata", "history.bin"), Buffer.from([0, 1, 255, 128]));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
describe("explicit offline environment recovery", () => {
  it("roundtrips contents and identity without overwriting the old directory", async () => {
    await backupLocalEnvironment(source, archive);
    await expect(restoreLocalEnvironment(archive, source)).rejects.toThrow("existing destination");
    await rename(source, join(home, "preserved"));
    await restoreLocalEnvironment(archive, source);
    expect(await readFile(join(source, "userdata", "history.bin"))).toEqual(
      Buffer.from([0, 1, 255, 128]),
    );
    expect(await readFile(join(source, "userdata", "environment-id"), "utf8")).toBe(
      "test-environment",
    );
    if (process.platform !== "win32") expect((await stat(archive)).mode & 0o777).toBe(0o700);
  });
  it("refuses nested backups and existing output directories", async () => {
    await expect(backupLocalEnvironment(source, join(source, "backup"))).rejects.toThrow("outside");
    await mkdir(archive);
    await expect(backupLocalEnvironment(source, archive)).rejects.toThrow();
  });
  it("refuses live or unverifiable runtime ownership", async () => {
    await writeFile(
      join(source, "userdata", "server-runtime.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        origin: "https://example.com",
        startedAt: new Date().toISOString(),
      }),
    );
    await expect(backupLocalEnvironment(source, archive)).rejects.toThrow("Stop the environment");
  });
  it("rejects a corrupt archive without creating a destination", async () => {
    await backupLocalEnvironment(source, archive);
    await rename(source, join(home, "preserved"));
    await writeFile(join(archive, "data", "userdata", "history.bin"), "corrupt");
    await expect(restoreLocalEnvironment(archive, source)).rejects.toThrow("integrity");
    await expect(stat(source)).rejects.toThrow();
  });
  it("refuses a live development server sharing the backup root", async () => {
    await mkdir(join(source, "dev"));
    await writeFile(join(source, "dev", "environment-id"), "development");
    await writeFile(
      join(source, "dev", "server-runtime.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        origin: "https://example.com",
        startedAt: new Date().toISOString(),
      }),
    );
    await expect(backupLocalEnvironment(source, archive)).rejects.toThrow("Stop the environment");
  });
  it("refuses portable identity clones and traversal manifests", async () => {
    await backupLocalEnvironment(source, archive);
    await expect(restoreLocalEnvironment(archive, join(home, "clone"))).rejects.toThrow(
      "original data directory",
    );
    const path = join(archive, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.files[0].path = "../escape";
    await writeFile(path, JSON.stringify(manifest));
    await expect(restoreLocalEnvironment(archive, source)).rejects.toThrow(
      "Invalid backup manifest",
    );
  });
  it("refuses symlinks without publishing a usable manifest", async () => {
    const target = join(home, "private");
    await mkdir(target);
    await symlink(
      target,
      join(source, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(backupLocalEnvironment(source, archive)).rejects.toThrow("Backup incomplete");
    await expect(stat(join(archive, "manifest.json"))).rejects.toThrow();
  });
});
