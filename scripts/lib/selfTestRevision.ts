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
    const metadata = await lstat(path);
    const type = metadata.isSymbolicLink() ? "symlink" : "file";
    if (!metadata.isSymbolicLink() && !metadata.isFile()) {
      throw new Error(`Unsupported untracked file type: ${file}`);
    }
    const contents = metadata.isSymbolicLink() ? await readlink(path) : await readFile(path);
    hash.update(JSON.stringify([file, type, metadata.mode & 0o111, Buffer.byteLength(contents)]));
    hash.update("\0").update(contents);
  }
  return { commit: commit.trim(), contentHash: hash.digest("hex") };
}
