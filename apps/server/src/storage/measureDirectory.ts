import fs from "node:fs/promises";
import path from "node:path";

export interface DirectorySize {
  readonly bytes: number;
  readonly files: number;
}

const DEFAULT_CONCURRENCY = 8;
const PROGRESS_EVERY_FILES = 2_000;

/**
 * Apparent size of a directory tree (sum of `lstat` sizes, symlinks not
 * followed). Directories are walked by a bounded worker pool; aborting stops
 * the walk and rejects with the signal's reason.
 */
export async function measureDirectory(
  root: string,
  options: {
    readonly signal?: AbortSignal;
    readonly concurrency?: number;
    readonly onProgress?: (size: DirectorySize) => void;
  } = {},
): Promise<DirectorySize> {
  const { signal } = options;
  let bytes = 0;
  let files = 0;
  const pending: string[] = [];
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
    pending.push(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: 0, files: 0 };
    throw error;
  }

  let active = 0;
  let waiters: Array<() => void> = [];
  const wakeIdle = () => {
    const current = waiters;
    waiters = [];
    for (const resolve of current) resolve();
  };
  const walkDirectory = async (directory: string) => {
    let handle;
    try {
      handle = await fs.opendir(directory);
    } catch {
      return;
    }
    for await (const entry of handle) {
      signal?.throwIfAborted();
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        wakeIdle();
        continue;
      }
      try {
        bytes += (await fs.lstat(entryPath)).size;
        files += 1;
        if (files % PROGRESS_EVERY_FILES === 0) options.onProgress?.({ bytes, files });
      } catch {
        // Vanished or unreadable entries do not count.
      }
    }
  };

  const worker = async () => {
    for (;;) {
      signal?.throwIfAborted();
      const next = pending.pop();
      if (next === undefined) {
        if (active === 0) {
          wakeIdle();
          return;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
        continue;
      }
      active += 1;
      try {
        await walkDirectory(next);
      } finally {
        active -= 1;
        wakeIdle();
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY) }, worker),
  );
  options.onProgress?.({ bytes, files });
  return { bytes, files };
}
