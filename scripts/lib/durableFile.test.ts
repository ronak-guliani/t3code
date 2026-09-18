import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDurableText, type DurableFileOperations, writeDurableFile } from "./durableFile.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makePath() {
  const root = await mkdtemp(join(tmpdir(), "t3-durable-file-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return join(root, "record.json");
}

const operations: DurableFileOperations = { writeFile, rename, rm };

describe("durable file replacement", () => {
  it("writes consecutive versions to one destination", async () => {
    const path = await makePath();

    await writeDurableFile(path, "first");
    await writeDurableFile(path, "second");
    await writeDurableFile(path, "third");

    expect(await readDurableText(path)).toBe("third");
  });

  it("retains the previous version when replacement fails before commit", async () => {
    const path = await makePath();
    const backup = `${path}.previous`;
    await writeDurableFile(path, "previous");
    const failing: DurableFileOperations = {
      ...operations,
      rename: async (source, destination) => {
        if (destination === path && source !== path) {
          const error = new Error("replace denied");
          Object.assign(error, { code: "EPERM" });
          throw error;
        }
        if (source === path && destination === backup) return rename(source, destination);
        return operations.rename(source, destination);
      },
    };

    await expect(writeDurableFile(path, "next", failing)).rejects.toThrow("replace denied");
    expect(await readDurableText(path)).toBe("previous");
  });

  it("retains the previous version when backup preparation fails", async () => {
    const path = await makePath();
    const backup = `${path}.previous`;
    await writeDurableFile(path, "previous");
    let firstReplacement = true;
    const failing: DurableFileOperations = {
      ...operations,
      rename: async (source, destination) => {
        if (destination === path && source !== path && firstReplacement) {
          firstReplacement = false;
          const error = new Error("replace denied");
          Object.assign(error, { code: "EPERM" });
          throw error;
        }
        if (source === path && destination === backup) throw new Error("backup denied");
        return operations.rename(source, destination);
      },
    };

    await expect(writeDurableFile(path, "next", failing)).rejects.toThrow("backup denied");
    expect(await readDurableText(path)).toBe("previous");
  });

  it("keeps the committed version when cleanup fails after commit", async () => {
    const path = await makePath();
    const backup = `${path}.previous`;
    await writeDurableFile(path, "previous");
    let firstReplacement = true;
    let backupRemoves = 0;
    const failing: DurableFileOperations = {
      ...operations,
      rename: async (source, destination) => {
        if (destination === path && source !== path && firstReplacement) {
          firstReplacement = false;
          const error = new Error("replace denied");
          Object.assign(error, { code: "EPERM" });
          throw error;
        }
        return operations.rename(source, destination);
      },
      rm: async (target, options) => {
        if (target === backup && ++backupRemoves === 2) {
          throw new Error("cleanup denied");
        }
        return operations.rm(target, options);
      },
    };

    await expect(writeDurableFile(path, "next", failing)).rejects.toThrow("cleanup denied");
    expect(await readFile(path, "utf8")).toBe("next");
    expect(await readDurableText(path)).toBe("next");
  });
});
