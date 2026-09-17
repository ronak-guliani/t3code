import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfTestCoordinator, SelfTestCoordinatorError } from "./self-test.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function fakeChild(pid: number) {
  const child = new EventEmitter() as ChildProcess & {
    release: () => void;
    fail: () => void;
  };
  Object.defineProperty(child, "pid", { value: pid });
  child.kill = (() => {
    child.emit("exit", null, "SIGTERM");
    return true;
  }) as ChildProcess["kill"];
  child.release = () => child.emit("exit", 0, null);
  child.fail = () => child.emit("exit", 1, null);
  return child;
}

async function makeStateDirectory() {
  const root = await mkdtemp(join(tmpdir(), "t3-self-test-coordinator-"));
  roots.push(root);
  return join(root, "state");
}

function validCaptureFiles(output: string) {
  return Promise.all([
    writeFile(
      join(output, "diagnostics.json"),
      JSON.stringify({
        pageErrors: 0,
        failedRequests: 0,
        consoleErrors: 0,
        expectedConsoleErrors: 1,
      }),
    ),
    writeFile(join(output, "page.png"), "screenshot"),
    writeFile(join(output, "page.webm"), "recording"),
    writeFile(
      join(output, "capture.json"),
      JSON.stringify({
        scenarios: ["pairing", "reload", "socket reconnect", "revocation"],
        media: [
          {
            kind: "screenshot",
            file: "page.png",
            sha256: "4441146b0fe1d5c6845af126ba5ce6003ea77d6b4cb04d14114f86a925c5dbca",
            sizeBytes: 10,
            width: 1280,
            height: 800,
          },
          {
            kind: "recording",
            file: "page.webm",
            sha256: "3ebb153fb24e4411400e94a9a92b0ec458c3a8473e51e03cd37d4a34c99dfda6",
            sizeBytes: 9,
            width: 1280,
            height: 800,
            durationSeconds: 1,
          },
        ],
        diagnostics: {
          pageErrors: 0,
          failedRequests: 0,
          consoleErrors: 0,
          expectedConsoleErrors: 1,
        },
      }),
    ),
  ]);
}

describe("self-test coordinator", () => {
  it("blocks an explicitly missing web target before spawning the smoke child", async () => {
    const stateDirectory = await makeStateDirectory();
    const previous = process.env.T3_SELF_TEST_WEB_TARGET;
    process.env.T3_SELF_TEST_WEB_TARGET = join(stateDirectory, "missing-web");
    let spawned = false;
    try {
      const coordinator = createSelfTestCoordinator({
        directory: stateDirectory,
        spawnChild: (() => {
          spawned = true;
          throw new Error("must not spawn");
        }) as typeof import("node:child_process").spawn,
      });
      await expect(coordinator.run()).rejects.toMatchObject({
        issue: { type: "web-target-missing" },
        stage: "preflight",
      });
      expect(spawned).toBe(false);
      const status = await coordinator.status();
      expect(status.status).toBe("blocked");
      const manifest = JSON.parse(await readFile(join(stateDirectory, "latest.json"), "utf8"));
      expect(manifest.stage).toBe("blocked");
      expect(manifest.process.role).toBe("coordinator");
    } finally {
      if (previous === undefined) delete process.env.T3_SELF_TEST_WEB_TARGET;
      else process.env.T3_SELF_TEST_WEB_TARGET = previous;
    }
  });

  it("does not complete from lifecycle output until the child exits", async () => {
    const stateDirectory = await makeStateDirectory();
    let child: ReturnType<typeof fakeChild> | undefined;
    const coordinator = createSelfTestCoordinator({
      directory: stateDirectory,
      spawnChild: (() => {
        child = fakeChild(987654);
        void (async () => {
          let output: string | undefined;
          for (let attempt = 0; attempt < 20 && !output; attempt += 1) {
            try {
              const latest = JSON.parse(
                await readFile(join(stateDirectory, "latest.json"), "utf8"),
              ) as { runId: string };
              output = join(stateDirectory, latest.runId);
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          if (!output) throw new Error("Coordinator did not persist its run directory.");
          await mkdir(output, { recursive: true });
          await writeFile(
            join(output, "lifecycle.json"),
            JSON.stringify({ stage: "capture", scenarios: ["pairing"] }),
          );
          await validCaptureFiles(output);
        })();
        return child;
      }) as unknown as typeof import("node:child_process").spawn,
      processAlive: () => true,
      processCommand: async () => "pnpm test:self",
    });
    const running = coordinator.run();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await coordinator.status()).status).toBe("running");
    child?.release();
    await expect(running).resolves.toMatchObject({ status: "passed" });
  });

  it("retains failed-run diagnostics and raw captures without creating passed media", async () => {
    const stateDirectory = await makeStateDirectory();
    let child: ReturnType<typeof fakeChild> | undefined;
    const coordinator = createSelfTestCoordinator({
      directory: stateDirectory,
      spawnChild: (() => {
        child = fakeChild(987656);
        void (async () => {
          let output: string | undefined;
          for (let attempt = 0; attempt < 20 && !output; attempt += 1) {
            try {
              const latest = JSON.parse(
                await readFile(join(stateDirectory, "latest.json"), "utf8"),
              ) as { runId: string };
              output = join(stateDirectory, latest.runId);
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          if (!output) throw new Error("Coordinator did not persist its run directory.");
          await mkdir(join(output, "raw"), { recursive: true });
          await writeFile(
            join(output, "lifecycle.json"),
            JSON.stringify({ stage: "assertions", scenarios: ["pairing"] }),
          );
          await writeFile(
            join(output, "diagnostics.json"),
            JSON.stringify({
              pageErrors: 1,
              failedRequests: 0,
              consoleErrors: 1,
              expectedConsoleErrors: 0,
            }),
          );
          await writeFile(join(output, "raw", "failed.webm"), "unverified recording");
        })();
        return child;
      }) as unknown as typeof import("node:child_process").spawn,
      processAlive: () => true,
      processCommand: async () => "pnpm test:self",
    });
    const running = coordinator.run();
    await new Promise((resolve) => setTimeout(resolve, 250));
    child?.fail();
    await expect(running).rejects.toBeInstanceOf(SelfTestCoordinatorError);
    const result = await coordinator.status();
    expect(result.status).toBe("failed");
    expect(result.manifest?.media).toEqual([]);
    expect(result.manifest?.diagnostics).toMatchObject({ pageErrors: 1, consoleErrors: 1 });
    expect(result.manifest?.artifacts).toEqual([
      expect.objectContaining({ file: "diagnostics.json" }),
      expect.objectContaining({ file: "lifecycle.json" }),
      expect.objectContaining({ file: "raw/failed.webm" }),
    ]);
  });

  it("rejects active lock contention and recovers only a verified stale owner", async () => {
    const stateDirectory = await makeStateDirectory();
    await mkdir(join(stateDirectory, "lock"), { recursive: true });
    await writeFile(
      join(stateDirectory, "lock", "owner.json"),
      JSON.stringify({
        pid: 42,
        runId: "active-run",
        command: "pnpm test:self",
        startedAt: "2026-09-16T00:00:00Z",
      }),
    );
    const active = createSelfTestCoordinator({
      directory: stateDirectory,
      processAlive: () => true,
      processCommand: async () => "pnpm test:self",
    });
    await expect(active.run()).rejects.toMatchObject({
      issue: { type: "lock-contention" },
    });

    const stale = createSelfTestCoordinator({
      directory: stateDirectory,
      processAlive: () => false,
      processCommand: async () => "",
      spawnChild: (() => {
        const child = fakeChild(987655);
        queueMicrotask(() => child.release());
        return child;
      }) as unknown as typeof import("node:child_process").spawn,
    });
    process.env.T3_SELF_TEST_WEB_TARGET = join(stateDirectory, "missing-web");
    await expect(stale.run()).rejects.toMatchObject({
      issue: { type: "web-target-missing" },
    });
    expect(await readFile(join(stateDirectory, "latest.json"), "utf8")).toContain(
      '"status": "blocked"',
    );
    delete process.env.T3_SELF_TEST_WEB_TARGET;
  });
});
