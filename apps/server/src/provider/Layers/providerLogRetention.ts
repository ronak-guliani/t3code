import fs from "node:fs";
import path from "node:path";

const PROVIDER_LOG_FILE = /\.(?:log|ndjson)(?:\.\d+)?$/;

export interface ProviderLogRetentionOptions {
  readonly directory: string;
  readonly maxBytes: number;
  readonly maxAgeMs: number;
  readonly nowMs?: number;
}

export interface ProviderLogRetentionResult {
  readonly filesRemoved: number;
  readonly bytesRemoved: number;
  readonly bytesRemaining: number;
}

interface ProviderLogFile {
  readonly path: string;
  readonly size: number;
  readonly modifiedAtMs: number;
}

function listProviderLogFiles(directory: string): Array<ProviderLogFile> {
  const files: Array<ProviderLogFile> = [];
  const pendingDirectories = [directory];

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    if (currentDirectory === undefined) continue;

    let entries: Array<fs.Dirent>;
    try {
      entries = fs.readdirSync(currentDirectory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !PROVIDER_LOG_FILE.test(entry.name)) continue;

      try {
        const stat = fs.statSync(entryPath);
        files.push({ path: entryPath, size: stat.size, modifiedAtMs: stat.mtimeMs });
      } catch {
        // A rotated file may disappear while the directory is being scanned.
      }
    }
  }

  return files;
}

/**
 * Applies age retention first, then removes the oldest provider logs until the
 * whole provider-log directory fits its byte budget. RotatingFileSink opens
 * files per write, so pruning an active log path is safe: its next write
 * recreates the path and its per-file rotation limit remains in force.
 */
export function pruneProviderLogs(
  options: ProviderLogRetentionOptions,
): ProviderLogRetentionResult {
  if (!Number.isFinite(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative finite number");
  }
  if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) {
    throw new RangeError("maxAgeMs must be a non-negative finite number");
  }

  const files = listProviderLogFiles(options.directory).toSorted(
    (left, right) => left.modifiedAtMs - right.modifiedAtMs || left.path.localeCompare(right.path),
  );
  const nowMs = options.nowMs ?? Date.now();
  let bytesRemaining = files.reduce((total, file) => total + file.size, 0);
  let filesRemoved = 0;
  let bytesRemoved = 0;

  const remove = (file: ProviderLogFile) => {
    try {
      fs.rmSync(file.path, { force: true });
      filesRemoved += 1;
      bytesRemoved += file.size;
      bytesRemaining -= file.size;
      return true;
    } catch {
      return false;
    }
  };

  const retained: Array<ProviderLogFile> = [];
  for (const file of files) {
    if (nowMs - file.modifiedAtMs > options.maxAgeMs) {
      remove(file);
    } else {
      retained.push(file);
    }
  }

  for (const file of retained) {
    if (bytesRemaining <= options.maxBytes) break;
    remove(file);
  }

  return { filesRemoved, bytesRemoved, bytesRemaining: Math.max(0, bytesRemaining) };
}
