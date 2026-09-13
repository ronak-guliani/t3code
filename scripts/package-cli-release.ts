import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePnpmWorkspaceConfig } from "./lib/pnpm-workspace.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";
import manifest from "../apps/server/package.json" with { type: "json" };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(root, "release-cli"));
const staging = await mkdtemp(join(tmpdir(), "t3-cli-release-"));
try {
  const catalog = parsePnpmWorkspaceConfig(
    await readFile(join(root, "pnpm-workspace.yaml"), "utf8"),
  );
  await readFile(join(root, "apps/server/dist/client/index.html"));
  await mkdir(output, { recursive: true });
  await cp(join(root, "apps/server/dist"), join(staging, "dist"), { recursive: true });
  await cp(join(root, "LICENSE"), join(staging, "LICENSE"));
  await writeFile(
    join(staging, "package.json"),
    JSON.stringify(
      {
        name: "@ronak-guliani/t3code",
        version: manifest.version,
        license: manifest.license,
        repository: { type: "git", url: "https://github.com/ronak-guliani/t3code" },
        type: "module",
        bin: { "t3-rg": "./dist/bin.mjs" },
        files: ["dist"],
        engines: { node: "^24.13.1" },
        dependencies: resolveCatalogDependencies(
          manifest.dependencies,
          catalog.catalog,
          "apps/server",
        ),
      },
      null,
      2,
    ),
  );
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--quiet", "--pack-destination", staging],
    {
      cwd: staging,
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  const tarball = join(staging, `ronak-guliani-t3code-${manifest.version}.tgz`);
  const digest = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  await cp(tarball, join(output, "t3code-cli.tgz"));
  await cp(join(root, "scripts/install-release-cli.mjs"), join(output, "install-t3-cli.mjs"));
  await writeFile(join(output, "t3code-cli.sha256"), `${digest}  t3code-cli.tgz\n`);
  console.log(`Fork CLI release assets: ${output}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
