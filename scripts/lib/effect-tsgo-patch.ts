import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

const require = createRequire(import.meta.url);

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function filesHaveEqualContents(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
  if (leftStat.size !== rightStat.size) return false;

  const [leftHash, rightHash] = await Promise.all([hashFile(left), hashFile(right)]);
  return leftHash === rightHash;
}

export async function removeNumberedEffectTsgoBackups(targetPath: string): Promise<string[]> {
  try {
    await stat(`${targetPath}.original`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const directory = dirname(targetPath);
  const backupPrefix = `${basename(targetPath)}.original.`;
  const entries = await readdir(directory, { withFileTypes: true });
  const backups = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(backupPrefix) &&
        /^\d+$/.test(entry.name.slice(backupPrefix.length)),
    )
    .map((entry) => join(directory, entry.name))
    .sort();

  await Promise.all(backups.map((path) => rm(path)));
  return backups;
}

export function resolveInstalledTypeScriptBinary(): string {
  const typescriptPackageJson = require.resolve("@typescript/native/package.json");
  const typescriptRequire = createRequire(typescriptPackageJson);
  const platformPackageName = `@typescript/typescript-${process.platform}-${process.arch}`;
  const platformPackageJson = typescriptRequire.resolve(`${platformPackageName}/package.json`);
  const binaryName = process.platform === "win32" ? "tsc.exe" : "tsc";
  return join(dirname(platformPackageJson), "lib", binaryName);
}

export function resolveEffectTsgoCli(): string {
  const packageJson = require.resolve("@effect/tsgo/package.json");
  return join(dirname(packageJson), "dist", "effect-tsgo.js");
}
