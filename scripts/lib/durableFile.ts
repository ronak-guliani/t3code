import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

export type DurableFileOperations = {
  readonly writeFile: typeof writeFile;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
};

const defaultOperations: DurableFileOperations = { writeFile, rename, rm };
const writeQueues = new Map<string, Promise<void>>();

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function isReplaceFallbackError(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(errorCode(error)));
}

export async function writeDurableFile(
  path: string,
  contents: string,
  operations: DurableFileOperations = defaultOperations,
): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      const backup = `${path}.previous`;
      try {
        await operations.writeFile(temporary, contents, { mode: 0o600 });
        try {
          await operations.rename(temporary, path);
          return;
        } catch (error) {
          if (!isReplaceFallbackError(error)) throw error;
        }

        // Windows cannot reliably rename over an existing file. Move the old
        // record to a durable sibling before committing the replacement.
        await operations.rm(backup, { force: true });
        try {
          await operations.rename(path, backup);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        await operations.rename(temporary, path);
        await operations.rm(backup, { force: true });
      } finally {
        await operations.rm(temporary, { force: true });
      }
    });
  writeQueues.set(path, current);
  try {
    await current;
  } finally {
    if (writeQueues.get(path) === current) writeQueues.delete(path);
  }
}

export async function readDurableText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return readFile(`${path}.previous`, "utf8");
  }
}
