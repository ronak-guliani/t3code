import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vite-plus/test";

import { copyCliRuntime } from "./cliRuntime.ts";

const temporaryDirectories: string[] = [];
const run = promisify(execFile);

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "t3-service-runtime-"));
  temporaryDirectories.push(root);
  const source = join(root, "source");
  const destination = join(root, "runtime");
  await mkdir(join(source, "dist", "client"), { recursive: true });
  await writeFile(join(source, "dist", "client", "index.html"), "client");
  return { root, source, destination };
}

async function writePackage(directory: string, manifest: object, code: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ type: "module", exports: "./index.js", ...manifest }),
  );
  await writeFile(join(directory, "index.js"), code);
}

async function linkPackage(target: string, path: string) {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

it("runs without the source installation, preserving versions, peers, cycles and native assets", async () => {
  const { root, source, destination } = await fixture();
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ dependencies: { a: "*", b: "*" }, optionalDependencies: { absent: "*" } }),
  );
  await writeFile(
    join(source, "dist", "bin.mjs"),
    'import a from "a"; import b from "b"; console.log(JSON.stringify([a, b]));',
  );
  const a = join(source, "node_modules", "a");
  const b = join(source, "store", "b");
  const otherA = join(source, "store", "other-a");
  await writePackage(a, { dependencies: { b: "*" } }, 'export default "one";');
  await writeFile(join(a, "native.node"), "native-asset");
  await writePackage(b, { dependencies: { a: "*" } }, 'import a from "a"; export default a;');
  await writePackage(
    otherA,
    {
      peerDependencies: { b: "*", absentPeer: "*" },
      peerDependenciesMeta: { absentPeer: { optional: true } },
    },
    'export default "two";',
  );
  await linkPackage(b, join(source, "node_modules", "b"));
  await linkPackage(otherA, join(b, "node_modules", "a"));
  await linkPackage(b, join(otherA, "node_modules", "b"));
  await copyCliRuntime(join(source, "dist"), destination);
  await rm(source, { recursive: true });

  const output = await run(process.execPath, [join(destination, "bin.mjs")], { cwd: root });
  expect(JSON.parse(output.stdout)).toEqual(["one", "two"]);
  expect(await readFile(join(destination, "node_modules", "a", "native.node"), "utf8")).toBe(
    "native-asset",
  );
  expect(await readFile(join(destination, "client", "index.html"), "utf8")).toBe("client");
});

it("preserves scoped package aliases and optional dependencies that are installed", async () => {
  const { source, destination } = await fixture();
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ optionalDependencies: { "@scope/alias": "npm:actual@1.0.0" } }),
  );
  await writePackage(
    join(source, "node_modules", "@scope", "alias"),
    { name: "actual" },
    "export default 42;",
  );
  await copyCliRuntime(join(source, "dist"), destination);
  expect(
    await readFile(join(destination, "node_modules", "@scope", "alias", "index.js"), "utf8"),
  ).toBe("export default 42;");
});

it("fails explicitly for missing required dependencies", async () => {
  const { source, destination } = await fixture();
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ dependencies: { "t3-missing-runtime-test-dependency": "*" } }),
  );
  await expect(copyCliRuntime(join(source, "dist"), destination)).rejects.toThrow(
    "Missing installed runtime dependency 't3-missing-runtime-test-dependency'",
  );
});
