import { chmod, cp, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import * as Schema from "effect/Schema";

const PackageManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependenciesMeta: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ optional: Schema.optional(Schema.Boolean) })),
  ),
});
const decodeManifest = Schema.decodeUnknownPromise(Schema.fromJsonString(PackageManifest));

const readManifest = async (directory: string) =>
  decodeManifest(await readFile(join(directory, "package.json"), "utf8"));

async function resolveDependency(directory: string, name: string) {
  if (!/^(?:@[a-zA-Z0-9._~-]+\/)?[a-zA-Z0-9_~][a-zA-Z0-9._~-]*$/.test(name)) {
    throw new Error(`Invalid runtime dependency name: ${name}`);
  }
  const paths = createRequire(join(directory, "package.json")).resolve.paths(name) ?? [];
  for (const path of paths) {
    try {
      return await realpath(join(path, name));
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !("code" in cause) ||
        (cause.code !== "ENOENT" && cause.code !== "ENOTDIR")
      ) {
        throw cause;
      }
    }
  }
  return undefined;
}

/**
 * Snapshot the installed dependency graph, not registry versions. Private relative links retain
 * pnpm/hoisted resolution (including multiple versions and cycles) without checkout dependencies.
 */
export async function copyCliRuntime(distDir: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(distDir, destination, { recursive: true, force: false, errorOnExist: true });
  await chmod(destination, 0o700);
  const packages = new Map<string, string>();
  const pending: Array<{ source: string; target: string }> = [];

  const linkDependencies = async (source: string, target: string) => {
    const manifest = await readManifest(source);
    const dependencies = {
      ...manifest.peerDependencies,
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    };
    for (const name of Object.keys(dependencies)) {
      const dependency = await resolveDependency(source, name);
      if (dependency === undefined) {
        const optional =
          manifest.optionalDependencies?.[name] !== undefined ||
          (manifest.dependencies?.[name] === undefined &&
            manifest.peerDependenciesMeta?.[name]?.optional === true);
        if (optional) continue;
        throw new Error(`Missing installed runtime dependency '${name}' required by ${source}.`);
      }
      let copied = packages.get(dependency);
      if (copied === undefined) {
        copied = join(destination, "node_modules", ".t3-packages", String(packages.size));
        packages.set(dependency, copied);
        pending.push({ source: dependency, target: copied });
      }
      const link = join(target, "node_modules", name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(
        process.platform === "win32" ? copied : relative(dirname(link), copied),
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  };

  await linkDependencies(dirname(distDir), destination);
  for (let index = 0; index < pending.length; index += 1) {
    const entry = pending[index]!;
    await cp(entry.source, entry.target, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
      filter: (path) => path !== join(entry.source, "node_modules"),
    });
    await linkDependencies(entry.source, entry.target);
  }
}
