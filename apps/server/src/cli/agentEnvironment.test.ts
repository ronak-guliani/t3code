import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { expect, it } from "vitest";
import { prepareAgentCliDirectory } from "./agentEnvironment.ts";
import { runProcess } from "../processRunner.ts";

it("prefers the server CLI over an older PATH installation and preserves arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "t3 cli ' test-"));
  try {
    const entrypoint = join(root, "server.mjs");
    await writeFile(
      entrypoint,
      "console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.T3CODE_HOME,electron:process.env.ELECTRON_RUN_AS_NODE}));",
    );
    const stale = join(root, "stale");
    await mkdir(stale);
    await writeFile(join(stale, "t3"), "#!/bin/sh\necho stale\n", { mode: 0o755 });
    const directory = await prepareAgentCliDirectory(root, {
      executable: process.execPath,
      entrypoint,
    });
    const args = ["chat", "show", "a title; not a command", "--messages"];
    const result = await runProcess(
      process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      process.platform === "win32"
        ? ["/d", "/c", "t3", ...args]
        : ["-c", 't3 "$@"', "test", ...args],
      {
        env: {
          ...process.env,
          PATH: [directory, stale, process.env.PATH].join(delimiter),
          T3CODE_HOME: root,
        },
      },
    );
    expect(JSON.parse(result.stdout)).toEqual({ args, home: root, electron: "1" });
    expect(await readFile(join(directory, "t3.cmd"), "utf8")).toContain("DisableDelayedExpansion");
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () =>
        prepareAgentCliDirectory(root, { executable: process.execPath, entrypoint }),
      ),
    );
    expect(concurrent).toEqual(Array(4).fill(directory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
