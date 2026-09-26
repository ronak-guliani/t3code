import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

const quoteSh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const quoteCmd = (value: string) => `"${value.replaceAll("%", "%%")}"`;

export async function prepareAgentCliDirectory(
  stateDir: string,
  runtime = {
    executable: process.execPath,
    entrypoint: fileURLToPath(
      new URL(import.meta.url.endsWith(".mjs") ? "./bin.mjs" : "../bin.ts", import.meta.url),
    ),
  },
): Promise<string> {
  for (const value of [runtime.executable, runtime.entrypoint]) {
    if (/[\r\n"]/u.test(value)) throw new Error("Unsupported character in CLI executable path.");
  }
  const sh = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quoteSh(runtime.executable)} ${quoteSh(runtime.entrypoint)} "$@"\n`;
  const cmd = `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset ELECTRON_RUN_AS_NODE=1\r\n${quoteCmd(runtime.executable)} ${quoteCmd(runtime.entrypoint)} %*\r\nexit /b %errorlevel%\r\n`;
  const key = createHash("sha256").update(sh).update(cmd).digest("hex").slice(0, 16);
  const directory = join(stateDir, "agent-cli", key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, text] of [
    ["t3", sh],
    ["t3.cmd", cmd],
  ] as const) {
    const target = join(directory, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, { mode: 0o755 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return directory;
}

// Scope this to the server process. Provider descendants inherit a CLI from the
// same distribution, not whichever unrelated installation happens to be on PATH.
export const installAgentCliEnvironment = (stateDir: string, baseDir: string) =>
  Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const directory = await prepareAgentCliDirectory(stateDir);
      const previous = {
        PATH: process.env.PATH,
        T3CODE_HOME: process.env.T3CODE_HOME,
        T3CODE_AGENT_CLI_DIR: process.env.T3CODE_AGENT_CLI_DIR,
      };
      process.env.PATH = [directory, process.env.PATH].filter(Boolean).join(delimiter);
      process.env.T3CODE_HOME = baseDir;
      process.env.T3CODE_AGENT_CLI_DIR = directory;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  );
