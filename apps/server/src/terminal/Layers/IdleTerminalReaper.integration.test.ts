import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_TERMINAL_ID, ThreadId, type OrchestrationThreadShell } from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { StorageCleanupPolicyFromSettingsTest } from "../../storage/StorageCleanupPolicy.ts";
import { PreviewManager } from "../../preview/Manager.ts";
import { TerminalManager } from "../Services/Manager.ts";
import {
  IdleTerminalReaper,
  type IdleTerminalReaperShape,
} from "../Services/IdleTerminalReaper.ts";
import type { PtyAdapterShape, PtyExitEvent, PtyProcess } from "../Services/PTY.ts";
import { processStartIdentity } from "../ownedProcessCleanup.ts";
import { makeIdleTerminalReaperLive } from "./IdleTerminalReaper.ts";
import { makeTerminalManagerWithOptions } from "./Manager.ts";

const oldTime = () => new Date(Date.now() - 5 * 60 * 60 * 1_000).toISOString();

function activeThread(overrides: Partial<OrchestrationThreadShell> = {}) {
  const timestamp = oldTime();
  return {
    id: ThreadId.make("thread-1"),
    updatedAt: timestamp,
    latestUserMessageAt: timestamp,
    latestTurn: null,
    pendingTurnStart: null,
    hasPendingQueuedTurn: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pinnedAt: null,
    session: { activeTurnId: null },
    ...overrides,
  } as unknown as OrchestrationThreadShell;
}

class TestPtyProcess implements PtyProcess {
  readonly pid: number;
  readonly killSignals: string[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  constructor(pid: number) {
    this.pid = pid;
  }
  write(): void {}
  resize(): void {}
  kill(signal?: string): void {
    this.killSignals.push(signal ?? "SIGTERM");
  }
  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }
  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

type ReaperRuntime = ManagedRuntime.ManagedRuntime<
  | TerminalManager
  | ProjectionSnapshotQuery
  | OrchestrationEngineService
  | ServerSettingsService
  | PreviewManager
  | IdleTerminalReaper,
  unknown
>;

describe("IdleTerminalReaper integration", () => {
  let runtime: ReaperRuntime | null = null;
  let scope: Scope.Closeable | null = null;
  let baseDir: string | null = null;
  const children: ReturnType<typeof spawn>[] = [];

  afterEach(async () => {
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = null;
    if (runtime) await runtime.dispose();
    runtime = null;
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try {
          process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
        } catch {
          // The cleanup under test already stopped it.
        }
      }
    }
    if (baseDir) await rm(baseDir, { recursive: true, force: true });
    baseDir = null;
  });

  async function createHarness(
    input: {
      readonly timeoutHours?: number | null;
      readonly thread?: OrchestrationThreadShell;
      readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
      readonly hasPreview?: boolean;
    } = {},
  ) {
    baseDir = await mkdtemp(path.join(tmpdir(), "t3-idle-terminal-reaper-"));
    const thread = input.thread ?? activeThread();
    const threads = input.threads ?? [thread];
    const spawned: TestPtyProcess[] = [];
    const dispatched: Array<{ type?: string; activity?: { summary?: string } }> = [];
    const ptyAdapter: PtyAdapterShape = {
      spawn: () =>
        Effect.sync(() => {
          const pty = new TestPtyProcess(90_000 + spawned.length);
          spawned.push(pty);
          return pty;
        }),
    };
    const terminalLayer = Layer.effect(
      TerminalManager,
      makeTerminalManagerWithOptions({
        logsDir: path.join(baseDir, "terminals"),
        ptyAdapter,
        processKillGraceMs: 0,
      }),
    );
    const snapshotQuery = {
      getThreadShellById: (threadId: ThreadId) =>
        Effect.succeed(Option.fromNullishOr(threads.find((entry) => entry.id === threadId))),
    } as unknown as ProjectionSnapshotQueryShape;
    const engine = {
      dispatch: (command: { type?: string; activity?: { summary?: string } }) =>
        Effect.sync(() => dispatched.push(command)),
    } as unknown as OrchestrationEngineShape;
    const previewManager = {
      list: () => Effect.succeed({ sessions: input.hasPreview ? [{}] : [] }),
    } as never;
    const dependencies = Layer.mergeAll(
      terminalLayer,
      Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
      Layer.succeed(OrchestrationEngineService, engine),
      Layer.succeed(PreviewManager, previewManager),
      ServerSettingsService.layerTest({
        idleTerminalStopHours: input.timeoutHours === undefined ? 0.000001 : input.timeoutHours,
      }),
    );
    runtime = ManagedRuntime.make(
      makeIdleTerminalReaperLive({ sweepIntervalMs: 60_000 })
        .pipe(Layer.provideMerge(StorageCleanupPolicyFromSettingsTest))
        .pipe(Layer.provideMerge(dependencies))
        .pipe(Layer.provide(NodeServices.layer)),
    );
    return {
      terminals: await runtime.runPromise(Effect.service(TerminalManager)),
      reaper: await runtime.runPromise(Effect.service(IdleTerminalReaper)),
      spawned,
      dispatched,
    };
  }

  async function startReaper(reaper: IdleTerminalReaperShape) {
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  it("stops idle terminals and records the reason", async () => {
    const { terminals, reaper, spawned, dispatched } = await createHarness();
    await runtime!.runPromise(
      terminals.open({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, cwd: process.cwd() }),
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    await startReaper(reaper);

    expect(spawned[0]?.killSignals).toContain("SIGTERM");
    expect(dispatched.some((command) => command.activity?.summary?.includes("terminal"))).toBe(
      true,
    );
  });

  it("keeps terminals when the thread has an open preview tab", async () => {
    const { terminals, reaper, spawned } = await createHarness({ hasPreview: true });
    await runtime!.runPromise(
      terminals.open({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: process.cwd(),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    await startReaper(reaper);
    expect(spawned[0]?.killSignals).toEqual([]);
  });

  it("keeps terminals for recent turns, pinned threads, and attached viewers", async () => {
    const current = new Date().toISOString();
    const recentThread = activeThread({
      latestTurn: {
        turnId: "turn-recent",
        state: "completed",
        requestedAt: current,
        startedAt: current,
        completedAt: current,
        assistantMessageId: null,
      } as never,
    });
    const pinnedThread = activeThread({
      id: ThreadId.make("thread-pinned"),
      pinnedAt: oldTime(),
    });
    const { terminals, reaper, spawned } = await createHarness({
      threads: [recentThread, pinnedThread],
    });
    await runtime!.runPromise(terminals.open({ threadId: "thread-1", cwd: process.cwd() }));
    await runtime!.runPromise(terminals.open({ threadId: "thread-pinned", cwd: process.cwd() }));
    const unsubscribe = await runtime!.runPromise(
      terminals.attachStream({ threadId: "thread-1" }, () => Effect.void),
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    await startReaper(reaper);
    expect(spawned.every((process) => process.killSignals.length === 0)).toBe(true);
    unsubscribe();
  });

  it("does not stop terminals when the current setting is null", async () => {
    const { terminals, reaper, spawned } = await createHarness({ timeoutHours: null });
    await runtime!.runPromise(terminals.open({ threadId: "thread-1", cwd: process.cwd() }));
    await startReaper(reaper);
    expect(spawned[0]?.killSignals).toEqual([]);

    const serverSettings = await runtime!.runPromise(Effect.service(ServerSettingsService));
    await runtime!.runPromise(serverSettings.updateSettings({ idleTerminalStopHours: 0.000001 }));
    await new Promise((resolve) => setTimeout(resolve, 15));
    await runtime!.runPromise(reaper.reconcileStartup);
    expect(spawned[0]?.killSignals).toContain("SIGTERM");
  });

  it("cleans a previous-instance orphan and rejects a reused PID with another start time", async () => {
    const { reaper } = await createHarness();
    const startProcess = async () => {
      const ownerToken = crypto.randomUUID();
      const command = process.platform === "win32" ? process.execPath : "/bin/sleep";
      const args = process.platform === "win32" ? ["-e", "setInterval(() => {}, 60_000)"] : ["60"];
      const child = spawn(command, args, {
        detached: process.platform !== "win32",
        stdio: "ignore",
        env: { ...process.env, T3_TERMINAL_OWNER_TOKEN: ownerToken },
        ...(process.platform === "win32" ? {} : { argv0: `T3_TERMINAL_OWNER_TOKEN=${ownerToken}` }),
      });
      children.push(child);
      await once(child, "spawn");
      const pid = child.pid;
      if (pid === undefined) throw new Error("process fixture did not start");
      const startIdentity = await processStartIdentity(pid);
      if (!startIdentity) throw new Error("could not inspect process fixture");
      return { child, pid, startIdentity, ownerToken };
    };
    const orphan = await startProcess();
    const reused = await startProcess();
    const threadPrefix = `terminal_${Buffer.from("thread-1").toString("base64url")}`;
    const directory = path.join(baseDir!, "terminals");
    const makeRecord = (process: typeof orphan, startIdentity: string) => ({
      version: 1,
      threadId: "thread-1",
      terminalId: "default",
      title: "Terminal",
      pid: process.pid,
      startIdentity,
      ownerToken: process.ownerToken,
      serverInstanceId: "fake-previous-instance",
      lastOutputAt: oldTime(),
    });
    await writeFile(
      path.join(directory, `${threadPrefix}.log.fake-previous-instance.${orphan.pid}.process.json`),
      JSON.stringify(makeRecord(orphan, orphan.startIdentity)),
    );
    await writeFile(
      path.join(
        directory,
        `${threadPrefix}_cmV1c2Vk.log.fake-previous-instance.${reused.pid}.process.json`,
      ),
      JSON.stringify(makeRecord(reused, `${reused.startIdentity}:reused`)),
    );
    const orphanExited = once(orphan.child, "exit");

    await runtime!.runPromise(reaper.reconcileStartup);
    await orphanExited;

    expect(orphan.child.signalCode).toBe("SIGTERM");
    expect(reused.child.exitCode).toBeNull();
    expect(reused.child.signalCode).toBeNull();
    process.kill(reused.pid, 0);
  });
});
