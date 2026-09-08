import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { runProcess } from "../../processRunner.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorktreeCleanupJobRepository } from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { ThreadDeletionReactorLive } from "./ThreadDeletionReactor.ts";
import { findCanonicalActiveWorktreeOwner } from "../worktreeOwnership.ts";
import {
  logCleanupCauseUnlessInterrupted,
  processAfterWorktreeReservation,
  runAfterThreadRuntimeTeardown,
} from "./ThreadDeletionReactor.ts";

function makeReadModel(threads: OrchestrationReadModel["threads"]): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads,
    workflowRuns: [],
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function makeThread(
  id: string,
  worktreePath: string | null,
  deletedAt: string | null = null,
): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    parentThreadId: null,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: "approval-required",
    pendingRuntimeMode: null,
    interactionMode: "default",
    branch: null,
    worktreePath,
    reviewResult: null,
    latestTurn: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    archivedAt: null,
    deletedAt,
    messages: [],
    proposedPlans: [],
    queuedTurns: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  describe("processAfterWorktreeReservation", () => {
    it("releases the ownership lock before slow cleanup work", async () => {
      let lockHeld = false;

      await Effect.runPromise(
        processAfterWorktreeReservation(
          (effect) =>
            Effect.sync(() => {
              lockHeld = true;
            }).pipe(
              Effect.andThen(effect),
              Effect.ensuring(
                Effect.sync(() => {
                  lockHeld = false;
                }),
              ),
            ),
          Effect.succeed(Option.some("reserved")),
          () =>
            Effect.sync(() => {
              expect(lockHeld).toBe(false);
            }),
        ),
      );
    });
  });

  describe("ThreadDeletionReactorLive", () => {
    it("removes a clean archived merged-PR worktree from a disposable Git repository", async () => {
      const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t3-cleanup-reactor-"));
      const worktreePath = path.join(repositoryRoot, "feature");
      const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
        const result = await runProcess("git", args, {
          cwd,
          timeoutMs: 15_000,
          maxBufferBytes: 128 * 1024,
          allowNonZeroExit: true,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Cleanup Test",
            GIT_AUTHOR_EMAIL: "cleanup@example.test",
            GIT_COMMITTER_NAME: "Cleanup Test",
            GIT_COMMITTER_EMAIL: "cleanup@example.test",
          },
        });
        if (result.code !== 0) {
          throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
        }
        return result.stdout;
      };

      await runGit(repositoryRoot, ["init", "-b", "main"]);
      await writeFile(path.join(repositoryRoot, "README.md"), "fixture\n");
      await runGit(repositoryRoot, ["add", "README.md"]);
      await runGit(repositoryRoot, ["commit", "-m", "fixture"]);
      await runGit(repositoryRoot, ["worktree", "add", "-b", "feature", worktreePath, "HEAD"]);

      const timestamp = new Date().toISOString();
      const project = {
        id: ProjectId.make("project-1"),
        title: "Cleanup fixture",
        workspaceRoot: repositoryRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      } satisfies OrchestrationReadModel["projects"][number];
      const thread = {
        ...makeThread("thread-cleanup-fixture", worktreePath),
        projectId: project.id,
        branch: "feature",
        archivedAt: timestamp,
        pullRequest: {
          number: 1,
          title: "Fixture",
          url: "https://github.com/example/repo/pull/1",
          baseBranch: "main",
          headBranch: "feature",
          state: "open" as const,
        },
      } satisfies OrchestrationReadModel["threads"][number];
      const readModel = {
        ...makeReadModel([thread]),
        projects: [project],
      };
      const resolvedPullRequest = {
        number: 1,
        title: "Fixture",
        url: "https://github.com/example/repo/pull/1",
        baseBranch: "main",
        headBranch: "feature",
        state: "merged" as const,
      };
      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        getReadModel: () => Effect.succeed(readModel),
        readEvents: () => Stream.empty,
        dispatch: () => Effect.succeed({ sequence: 1 }),
        withWorktreeLock: (effect) => effect,
        streamDomainEvents: Stream.empty,
        acquireDomainEventSubscription: Effect.die("unused in cleanup fixture"),
      });
      const configLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-cleanup-reactor-test-",
      });
      const runtime = ManagedRuntime.make(
        ThreadDeletionReactorLive.pipe(
          Layer.provide(engineLayer),
          Layer.provide(
            Layer.mock(ProviderService)({
              stopSession: () => Effect.void,
            }),
          ),
          Layer.provide(
            Layer.mock(TerminalManager)({
              close: () => Effect.void,
            }),
          ),
          Layer.provide(
            Layer.mock(GitManager)({
              resolvePullRequest: () => Effect.succeed({ pullRequest: resolvedPullRequest }),
            }),
          ),
          Layer.provide(
            Layer.mock(GitStatusBroadcaster)({
              refreshStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasOriginRemote: false,
                  isDefaultBranch: false,
                  branch: null,
                  hasWorkingTreeChanges: false,
                  workingTree: {
                    files: [],
                    insertions: 0,
                    deletions: 0,
                  },
                  hasUpstream: false,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }),
            }),
          ),
          Layer.provide(GitCoreLive),
          Layer.provide(SqlitePersistenceMemory),
          Layer.provide(configLayer),
          Layer.provide(NodeServices.layer),
        ),
      );

      try {
        const reactor = await runtime.runPromise(Effect.service(ThreadDeletionReactor));
        const jobs = await runtime.runPromise(Effect.service(WorktreeCleanupJobRepository));
        const scope = await runtime.runPromise(Scope.make("sequential"));
        try {
          await runtime.runPromise(reactor.start().pipe(Scope.provide(scope)));
          await runtime.runPromise(reactor.drain);

          const cleanup = await runtime.runPromise(jobs.getByThreadId(thread.id));
          expect(Option.getOrThrow(cleanup).status).toBe("completed");
          expect(await runGit(repositoryRoot, ["worktree", "list", "--porcelain"])).not.toContain(
            worktreePath,
          );
        } finally {
          await runtime.runPromise(Scope.close(scope, Exit.succeed(undefined)));
        }
      } finally {
        await runtime.dispose();
        await rm(repositoryRoot, { recursive: true, force: true });
      }
    });
  });

  describe("runAfterThreadRuntimeTeardown", () => {
    it("runs cleanup only after both teardown operations settle successfully", async () => {
      const events: string[] = [];

      await Effect.runPromise(
        runAfterThreadRuntimeTeardown(
          Effect.sync(() => {
            events.push("provider");
          }),
          Effect.sync(() => {
            events.push("terminal");
          }),
          Effect.sync(() => {
            events.push("cleanup");
          }),
        ),
      );

      expect(events.slice(0, 2).toSorted()).toEqual(["provider", "terminal"]);
      expect(events.at(-1)).toBe("cleanup");
    });

    it("does not run cleanup when teardown fails but still settles the other teardown", async () => {
      let terminalClosed = false;
      let cleanupRan = false;

      const exit = await Effect.runPromiseExit(
        runAfterThreadRuntimeTeardown(
          Effect.fail("provider stop failed"),
          Effect.sync(() => {
            terminalClosed = true;
          }),
          Effect.sync(() => {
            cleanupRan = true;
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(terminalClosed).toBe(true);
      expect(cleanupRan).toBe(false);
    });
  });

  describe("findCanonicalActiveWorktreeOwner", () => {
    const deletedThreadId = ThreadId.make("thread-deleted");
    const worktreePath = "/tmp/worktree";

    it("detects another active thread using a canonical path alias", async () => {
      const readModel = makeReadModel([
        makeThread("thread-deleted", worktreePath, "2026-07-30T00:00:01.000Z"),
        makeThread("thread-active", "/tmp/parent/../worktree"),
      ]);

      await expect(
        Effect.runPromise(
          findCanonicalActiveWorktreeOwner(readModel, deletedThreadId, worktreePath),
        ),
      ).resolves.toEqual(Option.some(ThreadId.make("thread-active")));
    });

    it("ignores deleted threads and different worktrees", async () => {
      const readModel = makeReadModel([
        makeThread("thread-deleted", worktreePath, "2026-07-30T00:00:01.000Z"),
        makeThread("thread-old", worktreePath, "2026-07-30T00:00:02.000Z"),
        makeThread("thread-other", "/tmp/other"),
      ]);

      await expect(
        Effect.runPromise(
          findCanonicalActiveWorktreeOwner(readModel, deletedThreadId, worktreePath),
        ),
      ).resolves.toEqual(Option.none());
    });

    it("ignores archived threads", async () => {
      const archivedOwner = {
        ...makeThread("thread-archived", worktreePath),
        archivedAt: "2026-07-30T00:00:02.000Z",
      };

      await expect(
        Effect.runPromise(
          findCanonicalActiveWorktreeOwner(
            makeReadModel([makeThread("thread-deleted", worktreePath), archivedOwner]),
            deletedThreadId,
            worktreePath,
          ),
        ),
      ).resolves.toEqual(Option.none());
    });
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});
