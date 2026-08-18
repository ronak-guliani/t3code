import { realpath } from "node:fs/promises";
import path from "node:path";

import { runProcess } from "../processRunner.ts";

export async function canonicalizeWorktreePath(worktreePath: string): Promise<string> {
  const resolved = path.resolve(worktreePath);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

export async function resolveGitWorktreeRoot(worktreePath: string): Promise<string | null> {
  const canonicalPath = await canonicalizeWorktreePath(worktreePath);
  try {
    const result = await runProcess("git", ["-C", canonicalPath, "rev-parse", "--show-toplevel"], {
      allowNonZeroExit: true,
      maxBufferBytes: 16 * 1024,
      timeoutMs: 5_000,
    });
    if (result.code !== 0) return null;

    const root = result.stdout.trim();
    return root.length === 0 ? null : await canonicalizeWorktreePath(root);
  } catch {
    return null;
  }
}
