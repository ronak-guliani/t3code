import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SelfTestRevision } from "./selfTestEvidence.ts";

const exec = promisify(execFile);

export async function readSelfTestRevision(cwd: string): Promise<SelfTestRevision> {
  const git = async (args: string[]) =>
    (await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout;
  const [commit, diff, untracked] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["diff", "HEAD", "--binary", "--no-ext-diff"]),
    git(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const hash = createHash("sha256").update(diff);
  for (const file of untracked.split("\0").filter(Boolean).sort()) {
    const path = join(cwd, file);
    const contents = (await lstat(path)).isSymbolicLink()
      ? await readlink(path)
      : await readFile(path);
    hash.update("\0").update(file).update("\0").update(contents);
  }
  return { commit: commit.trim(), contentHash: hash.digest("hex") };
}
