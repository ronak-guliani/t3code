import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) {
  throw new Error(
    "Usage: node install-t3-cli.mjs <release-version>. Pin a version from ronak-guliani/t3code Releases.",
  );
}
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major !== 24 || minor < 13 || (minor === 13 && patch < 1))
  throw new Error("Install Node 24.13.1 or newer within Node 24 first.");
if (!["x64", "arm64"].includes(process.arch))
  throw new Error(`Unsupported architecture: ${process.arch}`);
const root = join(homedir(), ".t3-cli");
const bin = join(root, "bin");
const lock = join(root, "install.lock");
const candidate = join(root, "versions", `${version}-${randomUUID()}`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
    timeout: command === npm ? 600_000 : 30_000,
    shell: process.platform === "win32" && command === npm,
    env: {
      ...process.env,
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
  if (result.error || result.status !== 0)
    throw new Error(`Installation command failed: ${command}`, {
      cause: result.error ?? result.stderr,
    });
  return result.stdout;
}
async function download(name) {
  const url = `https://github.com/ronak-guliani/t3code/releases/download/v${version}/${name}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body)
    throw new Error(`Release asset ${name} unavailable (HTTP ${response.status}).`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 256 * 1024 * 1024)
      throw new Error("Release asset exceeds the download size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
await mkdir(root, { recursive: true, mode: 0o700 });
if (!(await lstat(root)).isDirectory())
  throw new Error("CLI installation root must be a real directory.");
run(npm, ["--version"]);
run("git", ["--version"]);
await mkdir(lock, { mode: 0o700 }).catch((cause) => {
  throw new Error(
    `Another installer may be active. Inspect ${lock} before retrying; never remove a live install lock.`,
    { cause },
  );
});
let activated = false;
try {
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    { flag: "wx", mode: 0o600 },
  );
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  const [archive, checksum] = await Promise.all([
    download("t3code-cli.tgz"),
    download("t3code-cli.sha256"),
  ]);
  const expected = /^([a-f0-9]{64})  t3code-cli\.tgz\s*$/.exec(checksum.toString("utf8"))?.[1];
  if (!expected || createHash("sha256").update(archive).digest("hex") !== expected)
    throw new Error("Release checksum mismatch. Nothing was activated.");
  const tarball = join(candidate, "t3code-cli.tgz");
  await writeFile(tarball, archive, { mode: 0o600, flag: "wx" });
  await writeFile(join(candidate, "package.json"), JSON.stringify({ private: true }), {
    mode: 0o600,
    flag: "wx",
  });
  run(npm, ["install", "--no-package-lock", "--save-exact", "./t3code-cli.tgz"], candidate);
  const entrypoint = join(candidate, "node_modules", "@ronak-guliani", "t3code", "dist", "bin.mjs");
  const identity = JSON.parse(
    run(process.execPath, [entrypoint, "installation", "identity", "--json"], candidate, true),
  );
  if (identity.distribution !== "ronak-guliani/t3code" || identity.version !== version)
    throw new Error("Packaged executable identity does not match the requested release.");
  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { createRequire } from 'node:module'; createRequire(process.argv[1])('node-pty');",
      entrypoint,
    ],
    candidate,
  );
  await access(
    join(candidate, "node_modules", "@ronak-guliani", "t3code", "dist", "client", "index.html"),
  );
  const launcher = join(root, "launch.mjs");
  const launcherSource = `import { readFileSync } from 'node:fs';\nconst {entrypoint} = JSON.parse(readFileSync(new URL('./active.json', import.meta.url), 'utf8'));\nprocess.argv[1] = entrypoint;\nawait import((await import('node:url')).pathToFileURL(entrypoint).href);\n`;
  try {
    await writeFile(launcher, launcherSource, { flag: "wx", mode: 0o600 });
  } catch (cause) {
    if (cause.code !== "EEXIST" || (await readFile(launcher, "utf8")) !== launcherSource)
      throw new Error("Existing CLI launcher is not compatible; refusing to overwrite it.", {
        cause,
      });
  }
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const shim = join(bin, process.platform === "win32" ? "t3-rg.cmd" : "t3-rg");
  if (
    process.platform === "win32" &&
    [process.execPath, launcher].some((path) => /[%!^&|<>"\r\n]/.test(path))
  )
    throw new Error(
      "This Windows installation path cannot be safely represented in a command shim.",
    );
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const shimSource =
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${launcher}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(launcher)} "$@"\n`;
  try {
    await writeFile(shim, shimSource, { flag: "wx", mode: 0o700 });
  } catch (cause) {
    if (cause.code !== "EEXIST" || (await readFile(shim, "utf8")) !== shimSource)
      throw new Error("Existing command shim differs; refusing to overwrite it.", { cause });
  }
  if (process.platform !== "win32") await chmod(shim, 0o700);
  const pointer = join(root, `active-${randomUUID()}.json`);
  await writeFile(pointer, JSON.stringify({ version, entrypoint, executable: process.execPath }), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(pointer, join(root, "active.json"));
  activated = true;
  await rm(tarball);
  console.log(
    `Installed ${identity.distribution} ${identity.version}.\nCommand: ${shim}\nAdd ${bin} to your user PATH if desired.\nA running background host is unchanged. Use this executable's service update command with the existing --base-dir to update it.`,
  );
} finally {
  if (!activated) await rm(candidate, { recursive: true, force: true });
  await rm(lock, { recursive: true, force: true });
}
