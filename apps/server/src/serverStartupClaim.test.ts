import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeServerStartupClaim } from "./serverStartupClaim.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "t3-startup-claim-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const config = (stateDir: string) => ({
  stateDir,
  serverRuntimeStatePath: join(stateDir, "server-runtime.json"),
});
const claim = (stateDir: string) =>
  Layer.build(makeServerStartupClaim(config(stateDir)).pipe(Layer.provide(NodeServices.layer)));

describe("server startup ownership", () => {
  it("excludes a second startup before any runtime state has been published", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* claim(root);
          const second = yield* Effect.exit(Effect.scoped(claim(root)));
          expect(Exit.isFailure(second)).toBe(true);
        }),
      ),
    );
    await Effect.runPromise(Effect.scoped(claim(root)));
  });
  it("keeps separate environments and development state independent", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* claim(join(root, "userdata"));
          yield* claim(join(root, "dev"));
        }),
      ),
    );
  });
  it("revalidates legacy runtime ownership while holding the claim", async () => {
    await writeFile(
      join(root, "server-runtime.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 13773,
        origin: "http://127.0.0.1:13773",
        startedAt: new Date().toISOString(),
      }),
    );
    await expect(Effect.runPromise(Effect.scoped(claim(root)))).rejects.toThrow("already served");
  });
  it("refuses malformed runtime evidence", async () => {
    await writeFile(join(root, "server-runtime.json"), "{");
    await expect(Effect.runPromise(Effect.scoped(claim(root)))).rejects.toThrow("Cannot verify");
  });
  it("releases the OS claim after a separate process is killed", async () => {
    await mkdir(root, { recursive: true });
    const script = `
      import { Effect, Layer } from "effect";
      import * as NodeServices from "@effect/platform-node/NodeServices";
      import { makeServerStartupClaim } from ${JSON.stringify(new URL("./serverStartupClaim.ts", import.meta.url).href)};
      Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        yield* Layer.build(makeServerStartupClaim(${JSON.stringify(config(root))}).pipe(Layer.provide(NodeServices.layer)));
        console.log("claimed");
        yield* Effect.never;
      }))).catch(error => { console.error(error.message); process.exit(1); });
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Child did not acquire claim")), 10_000);
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`Claim child exited: ${code}`));
        });
        child.stdout.on("data", (data) => {
          if (String(data).includes("claimed")) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      await expect(Effect.runPromise(Effect.scoped(claim(root)))).rejects.toThrow("Cannot claim");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    await Effect.runPromise(Effect.scoped(claim(root)));
  });
});
