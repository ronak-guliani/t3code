import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import { copyCliRuntime } from "@t3tools/shared/cliRuntime";
import { loadRepoEnv, resolvePublicConfig } from "./lib/public-config.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function inspect(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

export async function resolveCliLink(path: string, home: string): Promise<string> {
  let available: string | undefined;
  for (const directory of path.split(delimiter)) {
    // pnpm injects workspace bin directories ahead of the user's shell PATH.
    if (!isAbsolute(directory) || directory.split(sep).includes("node_modules")) continue;
    const candidate = join(directory, "t3");
    const fromHome = relative(home, candidate);
    const ownedPath = !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome);
    if (ownedPath) available ??= candidate;
    const stat = await inspect(candidate);
    if (!stat) continue;
    if (!ownedPath || !stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to replace ${candidate}: expected a user-owned symlink. Remove or relocate that installation explicitly, then retry.`,
      );
    }
    return candidate;
  }
  if (available) return available;
  throw new Error(
    "Add ~/.local/bin to PATH, then retry. No user-owned bin directory is present on PATH.",
  );
}

export async function installCliPackage(source: string, installations: string, link: string) {
  const original = await inspect(link);
  if (original && !original.isSymbolicLink()) throw new Error(`Refusing to overwrite ${link}.`);
  await mkdir(dirname(link), { recursive: true });
  await mkdir(installations, { recursive: true, mode: 0o700 });
  const destination = await mkdtemp(join(installations, "cli-"));
  const entry = join(destination, "dist", "bin.mjs");
  const candidateLink = `${link}.${randomUUID()}.candidate`;
  let activated = false;
  try {
    await copyCliRuntime(join(source, "dist"), join(destination, "dist"));
    // Keep a normal package layout so service install can snapshot this installation again.
    await rename(join(destination, "dist", "node_modules"), join(destination, "node_modules"));
    await copyFile(join(source, "package.json"), join(destination, "package.json"));
    await chmod(entry, 0o755);
    execFileSync(process.execPath, [entry, "--help"], { stdio: "pipe" });
    const current = await inspect(link);
    if (current?.ino !== original?.ino || current?.dev !== original?.dev) {
      throw new Error(`${link} changed during installation; leaving the new owner untouched.`);
    }
    await symlink(entry, candidateLink);
    await rename(candidateLink, link);
    activated = true;
    return entry;
  } finally {
    await rm(candidateLink, { force: true });
    if (!activated) await rm(destination, { recursive: true, force: true });
  }
}

export async function waitForConnect(
  readStatus: () => string,
  wait: () => Promise<unknown> = () => sleep(2_000),
) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status: unknown = JSON.parse(readStatus());
    if (typeof status !== "object" || status === null || !("state" in status)) {
      throw new Error("The installed CLI returned an invalid Connect status.");
    }
    if (status.state === "linked-online") return;
    if (status.state !== "linked-offline" && status.state !== "link-pending") {
      throw new Error(
        "Connect setup is incomplete. Finish account authorization and background setup.",
      );
    }
    await wait();
  }
  throw new Error(
    "The CLI is installed, but Connect did not come online. Run `t3 service status` and `t3 connect status` with the same --base-dir for details.",
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      connect: { type: "boolean", default: false },
      "base-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("Usage: pnpm install:t3:cli [--connect] [--base-dir PATH]");
    return;
  }
  if (process.platform !== "darwin") throw new Error("This installer currently supports macOS.");
  const home = homedir();
  const link = await resolveCliLink(process.env.PATH ?? "", home);
  const env = {
    ...loadRepoEnv({ includeExample: true }),
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
  };
  const config = resolvePublicConfig(env);
  if (!config.relayUrl || !config.clerkPublishableKey || !config.clerkCliOAuthClientId) {
    throw new Error("Configure the complete public Connect deployment before building the CLI.");
  }
  for (const name of ["@t3tools/web", "t3"]) {
    execFileSync("pnpm", ["--filter", name, "build"], { cwd: repoRoot, env, stdio: "inherit" });
  }
  const entry = await installCliPackage(
    join(repoRoot, "apps", "server"),
    join(home, ".local", "share", "t3"),
    link,
  );
  console.log(
    `Installed the rebuilt CLI at ${link}. Existing data and account links are unchanged.`,
  );
  if (values.connect) {
    const baseDir = resolve(values["base-dir"] ?? process.env.T3CODE_HOME ?? join(home, ".t3"));
    execFileSync(process.execPath, [entry, "connect", "--base-dir", baseDir], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    await waitForConnect(() =>
      execFileSync(
        process.execPath,
        [entry, "connect", "status", "--base-dir", baseDir, "--json"],
        { encoding: "utf8", timeout: 10_000 },
      ),
    );
    console.log(
      "T3 Connect is linked and online. Sign into the same account on your other device.",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
