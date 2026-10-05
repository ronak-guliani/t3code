/*
 * "Clean up now" against a real temp state dir, real Git, and real SQLite.
 * Orchestration, provider sessions, terminals and the projection shell are
 * stubbed at their service boundary; cleanup, reservation, Git and the
 * filesystem are production code.
 *
 * Failure modes this guards (written before the implementation):
 * - preview lists an ineligible item (dirty, pinned, running turn, project
 *   checkout) or misses an eligible one, or misreports its bytes;
 * - execute removes something that was never previewed, or something that
 *   became unsafe after preview (dirty file, pinned chat, started turn);
 * - a reset deletes chat history: branches, checkpoint refs, message rows;
 * - a reclaimed worktree cannot be restored when the chat is reopened;
 * - the automatic-cleanup switch fails to pause archive cleanup, or also
 *   blocks the manual reset;
 * - low disk mode does not tighten log retention;
 * - an unproven validation environment is removed without explicit confirm.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadShell,
  type ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import {
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  PubSub,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { GitCoreLive } from "../git/Layers/GitCore.ts";
import { GitManager } from "../git/Services/GitManager.ts";
import { GitStatusBroadcaster } from "../git/Services/GitStatusBroadcaster.ts";
import { ThreadDeletionReactorLive } from "../orchestration/Layers/ThreadDeletionReactor.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../orchestration/Services/ThreadDeletionReactor.ts";
import { layerConfig as SqlitePersistenceLayer } from "../persistence/Layers/Sqlite.ts";
import { WorkspaceOwnershipRepository } from "../persistence/Services/WorkspaceOwnership.ts";
import { runProcess } from "../processRunner.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { validationEnvironmentStateDirectory } from "../validation/ValidationEnvironmentService.ts";
import { StorageCleanup } from "./StorageCleanup.ts";
import { StorageCleanupLive } from "./StorageCleanupLive.ts";
import {
  StorageCleanupPolicy,
  StorageCleanupPolicyLayer,
  StorageFreeSpaceProbe,
} from "./StorageCleanupPolicy.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: ReadonlyArray<string>): Promise<string> {
  const result = await runProcess("git", args, {
    cwd,
    timeoutMs: 15_000,
    maxBufferBytes: 1024 * 1024,
    allowNonZeroExit: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Storage Test",
      GIT_AUTHOR_EMAIL: "storage@example.test",
      GIT_COMMITTER_NAME: "Storage Test",
      GIT_COMMITTER_EMAIL: "storage@example.test",
    },
  });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function exists(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => true,
    () => false,
  );
}

async function writeBytes(target: string, bytes: number, ageMs = 0): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.alloc(bytes, "x"));
  if (ageMs > 0) {
    const at = new Date(Date.now() - ageMs);
    await fs.utimes(target, at, at);
  }
}

type FixtureThread = OrchestrationReadModel["threads"][number];

interface ThreadFlags {
  pinned?: boolean;
  runningTurn?: boolean;
}

function makeThread(input: {
  id: string;
  projectId: ProjectId;
  worktreePath: string | null;
  branch: string | null;
  archived: boolean;
  deleted?: boolean;
}): FixtureThread {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    id: ThreadId.make(input.id),
    projectId: input.projectId,
    parentThreadId: null,
    title: input.id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.3-codex" },
    runtimeMode: "approval-required",
    pendingRuntimeMode: null,
    interactionMode: "default",
    branch: input.branch,
    worktreePath: input.worktreePath,
    reviewResult: null,
    latestTurn: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: input.archived ? at : null,
    deletedAt: input.deleted ? at : null,
    messages: [],
    proposedPlans: [],
    queuedTurns: [],
    activities: [],
    checkpoints: [],
    session: null,
  } as FixtureThread;
}

function makeSettingsLayer(initial: Partial<ServerSettings>) {
  return Layer.effect(
    ServerSettingsService,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ServerSettings>({ ...DEFAULT_SERVER_SETTINGS, ...initial });
      const changes = yield* PubSub.unbounded<ServerSettings>();
      return {
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(ref),
        updateSettings: (patch) =>
          Ref.updateAndGet(ref, (current) => ({ ...current, ...patch }) as ServerSettings).pipe(
            Effect.tap((next) => PubSub.publish(changes, next)),
          ),
        streamChanges: Stream.fromPubSub(changes),
      } as ServerSettingsService["Service"];
    }),
  );
}

async function makeFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t3-storage-cleanup-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const baseDir = path.join(root, "base");
  const workspaces = path.join(root, ".t3-thread-workspaces", "repo-key");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await writeBytes(path.join(repo, "README.md"), 16);
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "init"]);

  const projectId = ProjectId.make("project-storage");
  const worktree = async (name: string) => {
    const worktreePath = path.join(workspaces, name);
    await git(repo, ["worktree", "add", "-b", `feature-${name}`, worktreePath, "HEAD"]);
    // Ignored dependency tree: the bulk of real worktree bytes, not user work.
    await fs.writeFile(path.join(worktreePath, ".gitignore"), "node_modules/\n");
    await git(worktreePath, ["add", ".gitignore"]);
    await git(worktreePath, ["commit", "-m", "ignore deps"]);
    await writeBytes(path.join(worktreePath, "node_modules", "dep.bin"), 64 * 1024);
    return worktreePath;
  };
  const paths = {
    clean: await worktree("clean"),
    becomesDirty: await worktree("dirty-later"),
    becomesPinned: await worktree("pinned-later"),
    turnStarts: await worktree("turn-later"),
    alreadyDirty: await worktree("dirty-now"),
    pinned: await worktree("pinned-now"),
  };
  await writeBytes(path.join(paths.alreadyDirty, "notes.txt"), 10);
  // History that a reset must keep: a checkpoint ref on the reclaimed chat.
  await git(repo, ["update-ref", "refs/t3/checkpoints/thread-clean/turn/1", "feature-clean"]);

  const archived = (id: string, worktreePath: string) =>
    makeThread({
      id,
      projectId,
      worktreePath,
      branch: `feature-${path.basename(worktreePath)}`,
      archived: true,
    });
  const state = {
    threads: [
      archived("thread-clean", paths.clean),
      archived("thread-dirty-later", paths.becomesDirty),
      archived("thread-pinned-later", paths.becomesPinned),
      archived("thread-turn-later", paths.turnStarts),
      archived("thread-dirty-now", paths.alreadyDirty),
      archived("thread-pinned-now", paths.pinned),
      makeThread({
        id: "thread-root",
        projectId,
        worktreePath: repo,
        branch: "main",
        archived: true,
      }),
      makeThread({
        id: "thread-live",
        projectId,
        worktreePath: null,
        branch: null,
        archived: false,
      }),
      makeThread({
        id: "thread-gone",
        projectId,
        worktreePath: null,
        branch: null,
        archived: false,
        deleted: true,
      }),
    ],
    flags: new Map<string, ThreadFlags>([["thread-pinned-now", { pinned: true }]]),
    freeBytes: 500 * 1024 ** 3,
  };
  const project = {
    id: projectId,
    title: "Storage fixture",
    workspaceRoot: repo,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  } satisfies OrchestrationReadModel["projects"][number];
  const readModel = (): OrchestrationReadModel => ({
    snapshotSequence: 0,
    projects: [project],
    threads: state.threads,
    workflowRuns: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const shell = (thread: FixtureThread): OrchestrationThreadShell => {
    const flags = state.flags.get(thread.id) ?? {};
    return {
      ...thread,
      pinnedAt: flags.pinned ? "2026-01-02T00:00:00.000Z" : null,
      latestTurn: flags.runningTurn ? ({ state: "running" } as FixtureThread["latestTurn"]) : null,
      pendingTurnStart: null,
      hasPendingQueuedTurn: false,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      latestUserMessageAt: null,
    } as unknown as OrchestrationThreadShell;
  };
  const domainEvents = await Effect.runPromise(Queue.unbounded<OrchestrationEvent>());

  const layer = StorageCleanupLive.pipe(
    Layer.provideMerge(ThreadDeletionReactorLive),
    Layer.provideMerge(StorageCleanupPolicyLayer),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, {
          getReadModel: () => Effect.sync(readModel),
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 1 }),
          withWorktreeLock: (effect) => effect,
          streamDomainEvents: Stream.fromQueue(domainEvents),
          acquireDomainEventSubscription: Effect.die("unused"),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: (threadId) =>
            Effect.sync(() => {
              const thread = state.threads.find((entry) => entry.id === threadId);
              return thread ? Option.some(shell(thread)) : Option.none();
            }),
          getShellSnapshot: () =>
            Effect.sync(
              () =>
                ({
                  snapshotSequence: 0,
                  projects: [],
                  threads: state.threads.filter((t) => t.deletedAt === null).map(shell),
                  updatedAt: "2026-01-01T00:00:00.000Z",
                }) as never,
            ),
        }),
        Layer.mock(ProviderService)({
          listSessions: () => Effect.succeed([]),
          stopSession: () => Effect.void,
        }),
        Layer.mock(TerminalManager)({
          close: () => Effect.void,
          subscribeMetadata: (listener) =>
            listener({ type: "snapshot", terminals: [] }).pipe(Effect.as(() => undefined)),
        }),
        Layer.mock(WorkspaceOwnershipRepository)({
          getByThreadId: () => Effect.succeed([]),
          release: () => Effect.void,
        }),
        Layer.mock(GitManager)({ resolvePullRequest: () => Effect.die("unused") }),
        Layer.mock(GitStatusBroadcaster)({ refreshStatus: () => Effect.die("unused") as never }),
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
        }),
        Layer.succeed(StorageFreeSpaceProbe, {
          probe: async () => ({ freeBytes: state.freeBytes, totalBytes: 1000 * 1024 ** 3 }),
        }),
        makeSettingsLayer({ automaticCleanupEnabled: false }),
      ),
    ),
    Layer.provideMerge(SqlitePersistenceLayer),
    Layer.provideMerge(ServerConfig.layerTest(repo, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const scope = await runtime.runPromise(Scope.make("sequential"));
  const config = await runtime.runPromise(Effect.service(ServerConfig));
  const run = <A, E>(effect: Effect.Effect<A, E, never>) => runtime.runPromise(effect);
  const services = {
    storage: await runtime.runPromise(Effect.service(StorageCleanup)),
    reactor: await runtime.runPromise(Effect.service(ThreadDeletionReactor)),
    policy: await runtime.runPromise(Effect.service(StorageCleanupPolicy)),
    sql: await runtime.runPromise(Effect.service(SqlClient.SqlClient)),
  };
  return {
    root,
    repo,
    paths,
    state,
    config,
    run,
    ...services,
    startReactor: async () => {
      await run(services.reactor.start().pipe(Scope.provide(scope)));
      await run(services.reactor.drain);
    },
    unarchive: async (threadId: string) => {
      state.threads = state.threads.map((thread) =>
        thread.id === threadId ? { ...thread, archivedAt: null } : thread,
      );
      await Effect.runPromise(
        Queue.offer(domainEvents, {
          sequence: 2,
          eventId: EventId.make(`event-unarchive-${threadId}`),
          type: "thread.unarchived",
          aggregateKind: "thread",
          aggregateId: ThreadId.make(threadId),
          occurredAt: new Date().toISOString(),
          commandId: CommandId.make(`command-unarchive-${threadId}`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { threadId: ThreadId.make(threadId), updatedAt: new Date().toISOString() },
        } as OrchestrationEvent),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await run(services.reactor.drain);
    },
    dispose: async () => {
      await runtime.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    },
  };
}

describe("StorageCleanup reset", () => {
  it("previews exactly the eligible items, skips items made unsafe, keeps history, and restores", async () => {
    const fixture = await makeFixture();
    try {
      const { config, paths, state, repo } = fixture;
      // Seed every other category with exact byte counts.
      const trashEntry = path.join(config.worktreesDir, "repo", ".t3-worktree-trash", "old-1");
      await writeBytes(path.join(trashEntry, "blob"), 8192);
      const backup = path.join(config.stateDir, "state.sqlite.before-retired-projector-fix-1");
      await writeBytes(backup, 4096);
      await writeBytes(path.join(config.providerLogsDir, "thread-gone.log.1"), 1000);
      const liveOldLog = path.join(config.providerLogsDir, "thread-live.log.1");
      await writeBytes(liveOldLog, 2000, 5 * DAY_MS);
      const target = {
        workspaceRoot: repo,
        worktreePath: null,
        branch: "main",
        revision: "abc",
        dirtyStateFingerprint: "clean",
        environmentIdentity: "env-a",
      };
      const staleDirectory = validationEnvironmentStateDirectory(config.baseDir, target as never);
      const ownership = "env-a:owner";
      const deadProcess = { pid: 99_999_999, startIdentity: "gone", ownershipIdentity: ownership };
      await writeBytes(path.join(staleDirectory, "server.log"), 300);
      await fs.writeFile(
        path.join(staleDirectory, "validation-environment.json"),
        JSON.stringify({
          version: 1,
          target: { ...target, stateDirectory: staleDirectory },
          ownershipIdentity: ownership,
          backend: { origin: "http://127.0.0.1:1", port: 1, process: deadProcess },
          web: { origin: "http://127.0.0.1:2", port: 2, process: deadProcess },
        }),
      );
      const unprovenDirectory = path.join(config.baseDir, "validation", "env-b", "unknown");
      await writeBytes(path.join(unprovenDirectory, "leftover.bin"), 500);
      // Free pages for the optional VACUUM item.
      await fixture.run(
        Effect.gen(function* () {
          yield* fixture.sql.unsafe("CREATE TABLE filler (blob BLOB)");
          yield* fixture.sql.unsafe("INSERT INTO filler VALUES (zeroblob(4 * 1024 * 1024))");
          yield* fixture.sql.unsafe("DROP TABLE filler");
        }),
      );
      await fixture.run(
        fixture.sql.unsafe(
          "INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at) VALUES ('m1', 'thread-clean', NULL, 'user', 'keep me', 0, '2026-01-01', '2026-01-01')",
        ),
      );

      // Master switch off: starting the reactor must not reclaim anything.
      await fixture.startReactor();
      for (const worktreePath of Object.values(paths)) {
        expect(await exists(worktreePath)).toBe(true);
      }

      // Low disk tightens log retention to 3 days, exposing the 5-day-old log.
      state.freeBytes = 50 * 1024 ** 3;
      const lowDisk = await fixture.run(fixture.policy.measureLowDisk);
      expect(lowDisk.active).toBe(true);
      expect((await fixture.run(fixture.policy.current)).providerLogRetentionDays).toBe(3);

      const plan = await fixture.run(fixture.storage.previewCleanup());
      const byId = new Map(plan.items.map((item) => [item.id, item]));
      expect(
        plan.items
          .filter((item) => item.category === "worktrees")
          .map((item) => item.id)
          .toSorted(),
      ).toEqual([
        "worktree:thread-clean",
        "worktree:thread-dirty-later",
        "worktree:thread-pinned-later",
        "worktree:thread-turn-later",
      ]);
      expect(byId.get(`trash:${trashEntry}`)?.estimatedBytes).toBe(8192);
      expect(
        byId.get("database-backup:state.sqlite.before-retired-projector-fix-1")?.estimatedBytes,
      ).toBe(4096);
      expect(byId.get("provider-logs:deletedThreads")?.estimatedBytes).toBe(1000);
      expect(byId.get("provider-logs:age")?.estimatedBytes).toBe(2000);
      expect(byId.get("provider-logs:age")?.description).toContain("3 days");
      expect(byId.get(`validation:${staleDirectory}`)).toMatchObject({
        needsManualReview: false,
        defaultSelected: true,
      });
      expect(byId.get(`validation:${unprovenDirectory}`)).toMatchObject({
        needsManualReview: true,
        defaultSelected: false,
      });
      expect(byId.get("database-vacuum")).toMatchObject({ defaultSelected: false });
      expect(byId.get("worktree:thread-clean")!.estimatedBytes).toBeGreaterThanOrEqual(64 * 1024);
      expect(plan.totalEstimatedBytes).toBe(
        plan.items.reduce((sum, item) => sum + item.estimatedBytes, 0),
      );

      // Made unsafe after preview.
      await writeBytes(path.join(paths.becomesDirty, "new-work.txt"), 10);
      state.flags.set("thread-pinned-later", { pinned: true });
      state.flags.set("thread-turn-later", { runningTurn: true });

      const selected = plan.items.filter((item) => item.defaultSelected).map((item) => item.id);
      const result = await fixture.run(
        fixture.storage.executeCleanup({ planId: plan.planId, itemIds: selected }),
      );
      const status = new Map(result.results.map((entry) => [entry.itemId, entry]));
      expect(status.get("worktree:thread-clean")?.status).toBe("removed");
      expect(status.get("worktree:thread-dirty-later")).toMatchObject({
        status: "skipped",
        reason: "has uncommitted or untracked changes",
      });
      expect(status.get("worktree:thread-pinned-later")).toMatchObject({
        status: "skipped",
        reason: "chat is pinned",
      });
      expect(status.get("worktree:thread-turn-later")).toMatchObject({
        status: "skipped",
        reason: "a turn is running",
      });
      expect(status.get(`validation:${unprovenDirectory}`)).toBeUndefined();
      expect(result.bytesFreed).toBe(
        result.results.reduce((sum, entry) => sum + entry.bytesFreed, 0),
      );

      expect(await exists(paths.clean)).toBe(false);
      for (const kept of [
        paths.becomesDirty,
        paths.becomesPinned,
        paths.turnStarts,
        paths.alreadyDirty,
        paths.pinned,
        repo,
        unprovenDirectory,
        config.dbPath,
      ]) {
        expect(await exists(kept)).toBe(true);
      }
      for (const removed of [trashEntry, backup, staleDirectory, liveOldLog]) {
        expect(await exists(removed)).toBe(false);
      }
      expect(await exists(path.join(paths.becomesDirty, "new-work.txt"))).toBe(true);

      // History survives: branch, checkpoint ref, and message rows.
      expect(await git(repo, ["rev-parse", "--verify", "feature-clean"])).toMatch(/^[0-9a-f]{40}$/);
      expect(
        await git(repo, ["rev-parse", "--verify", "refs/t3/checkpoints/thread-clean/turn/1"]),
      ).toMatch(/^[0-9a-f]{40}$/);
      const rows = await fixture.run(
        fixture.sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM projection_thread_messages WHERE thread_id = 'thread-clean'",
        ),
      );
      expect(Number(rows[0]?.count)).toBe(1);

      // A plan runs once; replaying it is rejected.
      const replay = await fixture.run(
        Effect.exit(fixture.storage.executeCleanup({ planId: plan.planId, itemIds: selected })),
      );
      expect(Exit.isFailure(replay)).toBe(true);

      // Reopening the chat restores its worktree on the same branch.
      await fixture.unarchive("thread-clean");
      expect(await git(paths.clean, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature-clean");

      // Manual review needs an explicit per-item selection; VACUUM runs once idle.
      state.flags.delete("thread-turn-later");
      const second = await fixture.run(fixture.storage.previewCleanup());
      const manual = second.items.find((item) => item.needsManualReview)!;
      const vacuum = second.items.find((item) => item.id === "database-vacuum")!;
      const confirmed = await fixture.run(
        fixture.storage.executeCleanup({
          planId: second.planId,
          itemIds: [manual.id, vacuum.id],
        }),
      );
      expect(confirmed.results.map((entry) => entry.status)).toEqual(["removed", "removed"]);
      expect(await exists(unprovenDirectory)).toBe(false);
      const freelist = await fixture.run(
        fixture.sql.unsafe<{ freelist_count: number }>("PRAGMA freelist_count"),
      );
      expect(Number(freelist[0]?.freelist_count)).toBe(0);
    } finally {
      await fixture.dispose();
    }
  }, 60_000);
});
