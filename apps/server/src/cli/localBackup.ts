import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Schema } from "effect";
import { inspectLocalEnvironment, isMissingFile } from "@t3tools/shared/localEnvironment";

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  sourceBaseDir: Schema.String,
  environmentId: Schema.String,
  createdAt: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
});
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest));

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".." && !part.includes(":"))
  );
}

async function scan(root: string, prefix = ""): Promise<{ path: string; sha256: string }[]> {
  const result: { path: string; sha256: string }[] = [];
  for (const entry of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${entry}` : entry;
    if (!safeRelativePath(path)) throw new Error(`Unsupported backup path: ${path}`);
    const absolute = join(root, path);
    const info = await lstat(absolute);
    if (info.isDirectory()) result.push(...(await scan(root, path)));
    else if (info.isFile()) result.push({ path, sha256: await digest(absolute) });
    else throw new Error(`Backup refuses symlinks and special files: ${path}`);
  }
  return result;
}

async function requireStopped(baseDir: string, expectedId?: string) {
  const environment = await inspectLocalEnvironment(baseDir);
  const development = await inspectLocalEnvironment(baseDir, "dev");
  if (
    !environment ||
    environment.status !== "offline" ||
    (development !== null && development.status !== "offline") ||
    (expectedId !== undefined && environment.environmentId !== expectedId)
  ) {
    throw new Error(
      "Stop the environment before backing it up. Missing, changed, running, and unverifiable environments are refused.",
    );
  }
  return environment;
}

async function copyVerified(
  source: string,
  destination: string,
  files: typeof Manifest.Type.files,
) {
  for (const file of files) {
    const from = join(source, file.path);
    if (!(await lstat(from)).isFile())
      throw new Error(`Backup entry is not a regular file: ${file.path}`);
    const to = join(destination, file.path);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(from, to);
    if ((await digest(to)) !== file.sha256)
      throw new Error(`Backup contents changed: ${file.path}`);
  }
}

export async function backupLocalEnvironment(baseDir: string, output: string): Promise<string> {
  const environment = await requireStopped(baseDir);
  const source = environment.baseDir;
  const target = resolve(await realpath(dirname(resolve(output))), basename(resolve(output)));
  const relationship = relative(source, target);
  if (
    relationship === "" ||
    (!relationship.startsWith(`..${sep}`) && relationship !== ".." && !isAbsolute(relationship))
  ) {
    throw new Error("Store the backup outside the environment data directory.");
  }
  await mkdir(target, { mode: 0o700 }); // Exclusive: never overwrite an existing backup.
  try {
    const files = await scan(source);
    await copyVerified(source, join(target, "data"), files);
    if (JSON.stringify(await scan(source)) !== JSON.stringify(files)) {
      throw new Error("The source changed during backup. Stop all writers and retry.");
    }
    await requireStopped(source, environment.environmentId);
    await writeFile(
      join(target, "manifest.json"),
      JSON.stringify({
        version: 1,
        sourceBaseDir: source,
        environmentId: environment.environmentId,
        createdAt: new Date().toISOString(),
        files,
      }),
      { mode: 0o600, flag: "wx" },
    );
    return target;
  } catch (cause) {
    throw new Error(
      `Backup incomplete at ${target}; no usable manifest was published. The source was not modified.`,
      { cause },
    );
  }
}

export async function restoreLocalEnvironment(archive: string, baseDir: string): Promise<void> {
  const root = await realpath(archive);
  const manifest = decodeManifest(await readFile(join(root, "manifest.json"), "utf8"));
  // Restore only the original location. Portable clones duplicate Connect identities and contain
  // absolute provider/worktree paths; importing them as a second runnable host is not safe.
  const target = resolve(await realpath(dirname(resolve(baseDir))), basename(resolve(baseDir)));
  if (target !== manifest.sourceBaseDir)
    throw new Error(
      "Recovery must use the original data directory. Moving or merging environments is not supported.",
    );
  if (
    manifest.files.length === 0 ||
    manifest.files.some(
      (file) => !safeRelativePath(file.path) || !/^[0-9a-f]{64}$/.test(file.sha256),
    ) ||
    new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length
  ) {
    throw new Error("Invalid backup manifest.");
  }
  const source = join(root, "data");
  if (!(await lstat(source)).isDirectory())
    throw new Error("Backup data must be a real directory, not a link.");
  const actual = await scan(source);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error("Backup integrity verification failed.");
  const id = (await readFile(join(source, "userdata", "environment-id"), "utf8")).trim();
  if (id !== manifest.environmentId) throw new Error("Backup identity verification failed.");
  try {
    await lstat(target);
    throw new Error(
      "Recovery refuses an existing destination. Stop its server and preserve the old directory separately first.",
    );
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const stage = `${target}.restore-${randomUUID()}`;
  await mkdir(stage, { mode: 0o700 });
  try {
    await copyVerified(
      source,
      stage,
      manifest.files.filter(
        (file) =>
          file.path !== "userdata/server-runtime.json" && file.path !== "dev/server-runtime.json",
      ),
    );
    try {
      await lstat(target);
      throw new Error("The destination appeared during recovery; refusing to replace it.");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await rename(stage, target);
  } catch (cause) {
    throw new Error(
      `Recovery incomplete; staged data retained at ${stage}. The destination was not replaced.`,
      { cause },
    );
  }
}
