import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSelfTestRevision } from "./selfTestRevision.ts";

const exec = promisify(execFile);
let cwd: string;
const git = (args: string[]) => exec("git", args, { cwd });

describe("self-test revision identity", () => {
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "t3-self-test-revision-"));
    await git(["init", "--quiet"]);
    await writeFile(join(cwd, "source.txt"), "baseline\n");
    await git(["add", "source.txt"]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "baseline",
    ]);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("is stable across staging but distinguishes trailing whitespace edits", async () => {
    await writeFile(join(cwd, "source.txt"), "changed \n");
    const first = await readSelfTestRevision(cwd);
    await git(["add", "source.txt"]);
    expect(await readSelfTestRevision(cwd)).toEqual(first);
    await writeFile(join(cwd, "source.txt"), "changed  \n");
    expect((await readSelfTestRevision(cwd)).contentHash).not.toBe(first.contentHash);
  });

  it("hashes untracked content, including filenames with leading whitespace", async () => {
    const baseline = await readSelfTestRevision(cwd);
    await writeFile(join(cwd, " new.txt"), "one");
    const first = await readSelfTestRevision(cwd);
    expect(first.contentHash).not.toBe(baseline.contentHash);
    await writeFile(join(cwd, " new.txt"), "two");
    expect((await readSelfTestRevision(cwd)).contentHash).not.toBe(first.contentHash);
  });

  it.skipIf(process.platform === "win32")(
    "distinguishes a file from a symlink with identical payload bytes",
    async () => {
      const path = join(cwd, "entry");
      await writeFile(path, "target");
      const regular = await readSelfTestRevision(cwd);
      await rm(path);
      await symlink("target", path);
      expect((await readSelfTestRevision(cwd)).contentHash).not.toBe(regular.contentHash);
    },
  );

  it.skipIf(process.platform === "win32")(
    "invalidates executable-mode changes on untracked files",
    async () => {
      const path = join(cwd, "script");
      await writeFile(path, "#!/bin/sh\nexit 0\n");
      await chmod(path, 0o644);
      const regular = await readSelfTestRevision(cwd);
      await chmod(path, 0o755);
      expect((await readSelfTestRevision(cwd)).contentHash).not.toBe(regular.contentHash);
    },
  );

  it.skipIf(process.platform === "win32")(
    "hashes a symlink without following it outside the checkout",
    async () => {
      await symlink("/does-not-exist/outside-checkout", join(cwd, "link"));
      await expect(readSelfTestRevision(cwd)).resolves.toMatchObject({
        commit: expect.any(String),
      });
    },
  );
});
