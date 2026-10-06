import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  GitManagerError,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type TerminalSummary,
  type WorkspaceBinding,
} from "@t3tools/contracts";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Queue,
  Scope,
  Stream,
} from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { makeStorageCleanupPolicyTest } from "../../storage/StorageCleanupPolicy.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { canonicalizeWorktreePath } from "../../git/worktreePaths.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { runProcess } from "../../processRunner.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { WorktreeCleanupJobRepository } from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { WorkspaceOwnershipRepository } from "../../persistence/Services/WorkspaceOwnership.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { ThreadWorktreeRestorerRegistry } from "../Services/ThreadWorktreeRestorerRegistry.ts";
import { admitWorkspaceCommand, type WorkspaceAdmissionDeps } from "../workspaceAdmission.ts";
import {
  groupOpenPullRequestAssociationRefreshes,
  resolvePullRequestFromCwds,
  ThreadDeletionReactorLive,
  worktreeTrashDirectory,
} from "./ThreadDeletionReactor.ts";
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

type FixtureThread = OrchestrationReadModel["threads"][number];

interface CleanupFixture {
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly setupScriptRuns: Array<string>;
  readonly dispatched: Array<OrchestrationCommand>;
  readonly activityCommands: Array<OrchestrationCommand>;
  readonly runGit: (cwd: string, args: ReadonlyArray<string>) => Promise<string>;
  readonly registeredWorktrees: () => Promise<string>;
  readonly jobStatus: () => Promise<string | undefined>;
  /** Starts the reactor (startup archive sweep) and waits for cleanup to settle. */
  readonly start: () => Promise<void>;
  /** Unarchives the thread through a domain event and waits for the reactor. */
  readonly unarchive: () => Promise<void>;
  readonly enqueueIdleCleanup: () => Promise<void>;
  readonly reserveIdleCleanup: () => Promise<void>;
  readonly thread: () => FixtureThread;
  readonly turnStart: () => Promise<OrchestrationCommand>;
  readonly waitForSetupScript: () => Promise<void>;
}

interface CleanupFixtureOptions {
  readonly pullRequest: NonNullable<FixtureThread["pullRequest"]> | null;
  readonly idleWorktreeReclaimDays?: number | null;
  readonly threadOverrides?: Partial<FixtureThread>;
  readonly additionalThreadFactory?: (
    worktreePath: string,
    projectId: FixtureThread["projectId"],
  ) => ReadonlyArray<FixtureThread>;
  readonly terminalSummaries?: ReadonlyArray<TerminalSummary>;
  readonly providerSessions?: ReadonlyArray<never>;
  readonly pendingApprovalCount?: number;
  readonly pendingUserInputCount?: number;
}

function projectionThreadForFixture(thread: FixtureThread) {
  const userMessages = thread.messages.filter((message) => message.role === "user");
  const latestUserMessageAt = userMessages
    .map((message) => message.createdAt)
    .toSorted()
    .at(-1);
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    pendingRuntimeMode: thread.pendingRuntimeMode ?? null,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    pullRequest: thread.pullRequest ?? null,
    latestTurnId: thread.latestTurn?.turnId ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride ?? null,
    settledAt: thread.settledAt ?? null,
    snoozedUntil: thread.snoozedUntil ?? null,
    snoozedAt: thread.snoozedAt ?? null,
    pinnedAt: thread.pinnedAt ?? null,
    pinOrderKey: thread.pinOrderKey ?? null,
    latestUserMessageAt: latestUserMessageAt ?? null,
    latestChildNotificationAt: null,
    queueHeldAt: null,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    hasActionableProposedPlan: 0,
    deletedAt: thread.deletedAt,
  };
}

/**
 * Runs the production cleanup reactor against a disposable Git repository with
 * one chat that owns a `feature` worktree. Only orchestration, provider,
 * terminal, and PR-resolution boundaries are stubbed; Git and SQLite are real.
 */
async function withCleanupFixture(
  options: CleanupFixtureOptions,
  body: (fixture: CleanupFixture) => Promise<void>,
): Promise<void> {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "t3-cleanup-reactor-"));
  const repositoryRoot = path.join(fixtureRoot, "repo");
  const worktreePath = path.join(fixtureRoot, "feature");
  await mkdir(repositoryRoot);
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
  let thread: FixtureThread = {
    ...makeThread("thread-cleanup-fixture", worktreePath),
    projectId: project.id,
    branch: "feature",
    archivedAt: timestamp,
    pullRequest: options.pullRequest,
    ...options.threadOverrides,
  };
  const readModel = () => ({
    ...makeReadModel([
      thread,
      ...(options.additionalThreadFactory?.(worktreePath, project.id) ?? []),
    ]),
    projects: [project],
  });
  const resolvedPullRequest =
    options.pullRequest === null ? null : { ...options.pullRequest, state: "merged" as const };
  const setupScriptRuns: Array<string> = [];
  const dispatched: Array<OrchestrationCommand> = [];
  const activityCommands: Array<OrchestrationCommand> = [];
  let resolveSetupScriptRun: (() => void) | undefined;
  const setupScriptRun = new Promise<void>((resolve) => {
    resolveSetupScriptRun = resolve;
  });
  const domainEvents = await Effect.runPromise(Queue.unbounded<OrchestrationEvent>());

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    getReadModel: () => Effect.sync(readModel),
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        if (command.type === "thread.activity.append") activityCommands.push(command);
        return { sequence: 1 };
      }),
    withWorktreeLock: (effect) => effect,
    streamDomainEvents: Stream.fromQueue(domainEvents),
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
          listSessions: () => Effect.succeed(options.providerSessions ?? []),
        }),
      ),
      Layer.provide(
        Layer.mock(TerminalManager)({
          close: () => Effect.void,
          subscribeMetadata: (listener) =>
            listener({ type: "snapshot", terminals: [...(options.terminalSummaries ?? [])] }).pipe(
              Effect.as(() => undefined),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(WorkspaceOwnershipRepository)({
          getByThreadId: () => Effect.succeed([]),
          release: () => Effect.void,
        }),
      ),
      Layer.provide(
        Layer.mock(GitManager)({
          resolvePullRequest: () =>
            resolvedPullRequest === null
              ? Effect.die("archive cleanup must not require a pull request")
              : Effect.succeed({ pullRequest: resolvedPullRequest }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: (input) =>
            Effect.sync(() => {
              setupScriptRuns.push(input.worktreePath);
              resolveSetupScriptRun?.();
              return { status: "no-script" as const };
            }),
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
              workingTree: { files: [], insertions: 0, deletions: 0 },
              hasUpstream: false,
              aheadCount: 0,
              behindCount: 0,
              pr: null,
            }),
        }),
      ),
      Layer.provide(GitCoreLive),
      Layer.provideMerge(ProjectionThreadRepositoryLive),
      Layer.provide(
        makeStorageCleanupPolicyTest({
          idleWorktreeReclaimDays:
            options.idleWorktreeReclaimDays === undefined ? 7 : options.idleWorktreeReclaimDays,
        }),
      ),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(
        ServerSettingsService.layerTest({
          idleWorktreeReclaimDays:
            options.idleWorktreeReclaimDays === undefined ? 7 : options.idleWorktreeReclaimDays,
        } as never),
      ),
      Layer.provide(configLayer),
      Layer.provide(NodeServices.layer),
    ),
  );

  const scope = await runtime.runPromise(Scope.make("sequential"));
  try {
    const reactor = await runtime.runPromise(Effect.service(ThreadDeletionReactor));
    const jobs = await runtime.runPromise(Effect.service(WorktreeCleanupJobRepository));
    const restorer = await runtime.runPromise(Effect.service(ThreadWorktreeRestorerRegistry));
    const projectionThreads = await runtime.runPromise(Effect.service(ProjectionThreadRepository));
    await runtime.runPromise(
      projectionThreads.upsert({
        ...projectionThreadForFixture(thread),
        pendingApprovalCount: options.pendingApprovalCount ?? 0,
        pendingUserInputCount: options.pendingUserInputCount ?? 0,
      }),
    );
    await body({
      repositoryRoot,
      worktreePath,
      setupScriptRuns,
      dispatched,
      activityCommands,
      runGit,
      registeredWorktrees: () => runGit(repositoryRoot, ["worktree", "list", "--porcelain"]),
      jobStatus: async () =>
        Option.getOrUndefined(await runtime.runPromise(jobs.getByThreadId(thread.id)))?.status,
      start: async () => {
        await runtime.runPromise(reactor.start().pipe(Scope.provide(scope)));
        await runtime.runPromise(reactor.drain);
      },
      unarchive: async () => {
        const updatedAt = new Date().toISOString();
        thread = { ...thread, archivedAt: null, updatedAt };
        await Effect.runPromise(
          Queue.offer(domainEvents, {
            sequence: 2,
            eventId: EventId.make("event-unarchive"),
            type: "thread.unarchived",
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt: updatedAt,
            commandId: CommandId.make("command-unarchive"),
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: { threadId: thread.id, updatedAt },
          } as OrchestrationEvent),
        );
        // Let the domain-event fiber hand the event to the worker before draining.
        await new Promise((resolve) => setTimeout(resolve, 50));
        await runtime.runPromise(reactor.drain);
      },
      enqueueIdleCleanup: async () => {
        await runtime.runPromise(
          jobs.enqueue({
            threadId: thread.id,
            cwd: project.workspaceRoot,
            worktreePath: thread.worktreePath!,
            canonicalWorktreePath: await canonicalizeWorktreePath(thread.worktreePath!),
            requestedAt: new Date().toISOString(),
            source: "idle",
            allowTerminalReset: false,
          } as never),
        );
      },
      reserveIdleCleanup: async () => {
        const reservation = await runtime.runPromise(
          jobs.tryReserveForRemoval({
            threadId: thread.id,
            canonicalWorktreePath: await canonicalizeWorktreePath(thread.worktreePath!),
            reservedAt: new Date().toISOString(),
          }),
        );
        expect(Option.isSome(reservation)).toBe(true);
      },
      thread: () => thread,
      turnStart: async () => {
        const deps: WorkspaceAdmissionDeps = {
          findThread: (threadId) =>
            readModel().threads.find((candidate) => candidate.id === threadId),
          findProject: (projectId) =>
            readModel().projects.find((candidate) => candidate.id === projectId),
          listThreads: () => readModel().threads,
          claimOwnership: (input) =>
            Effect.succeed<WorkspaceBinding>({
              canonicalPath: path.resolve(input.worktreePath),
              worktreePath: input.worktreePath,
              branch: input.branch,
              generation: 1,
            }),
          hasCleanupReservationByPath: jobs.hasReservationByPath,
          hasCleanupReservationByThreadId: jobs.hasReservationByThreadId,
          cancelIdleByThreadId: jobs.cancelIdleByThreadId,
          restoreThreadWorktree: restorer.restore,
          createWorkspaceSnapshotCommit: () =>
            Effect.die("workspace snapshots are not used for an existing-thread turn"),
        };
        return await Effect.runPromise(
          admitWorkspaceCommand(deps, {
            type: "thread.turn.start",
            commandId: CommandId.make(`turn-${crypto.randomUUID()}`),
            threadId: thread.id,
          } as OrchestrationCommand),
        );
      },
      waitForSetupScript: async () =>
        await Promise.race([
          setupScriptRun,
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("setup script did not start")), 2_000),
          ),
        ]),
    });
  } finally {
    await runtime.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    await runtime.dispose();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
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

    it("skips stale queued cleanup after unarchive before worker execution", async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const blockerStarted = yield* Deferred.make<void>();
            const releaseBlocker = yield* Deferred.make<void>();
            let archived = true;
            let stopSessionCalls = 0;
            let terminalCloseCalls = 0;
            let terminalHistoryDeletes = 0;
            let worktreeRemovalCalls = 0;

            const worker = yield* makeDrainableWorker<"block" | "cleanup", never, never>(
              (item): Effect.Effect<void, never, never> =>
                item === "block"
                  ? Deferred.succeed(blockerStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseBlocker)),
                    )
                  : processAfterWorktreeReservation(
                      (effect: Effect.Effect<Option.Option<string>, never, never>) => effect,
                      Effect.sync(() =>
                        archived ? Option.some("reserved") : Option.none<string>(),
                      ),
                      () =>
                        runAfterThreadRuntimeTeardown(
                          Effect.sync(() => {
                            stopSessionCalls += 1;
                          }),
                          Effect.sync(() => {
                            terminalCloseCalls += 1;
                            terminalHistoryDeletes += 1;
                          }),
                          Effect.sync(() => {
                            worktreeRemovalCalls += 1;
                          }),
                        ),
                    ),
            );

            yield* worker.enqueue("block");
            yield* worker.enqueue("cleanup");
            yield* Deferred.await(blockerStarted);

            archived = false;
            yield* Deferred.succeed(releaseBlocker, undefined);
            yield* worker.drain;

            expect(stopSessionCalls).toBe(0);
            expect(terminalCloseCalls).toBe(0);
            expect(terminalHistoryDeletes).toBe(0);
            expect(worktreeRemovalCalls).toBe(0);
          }),
        ),
      );
    });
  });

  describe("ThreadDeletionReactorLive", () => {
    it("groups the same PR identity across worktrees into one resolver lookup", () => {
      const timestamp = "2026-09-14T12:00:00.000Z";
      const project = {
        id: ProjectId.make("project-1"),
        title: "Refresh grouping",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      } satisfies OrchestrationReadModel["projects"][number];
      const pullRequest = {
        number: 42,
        title: "Shared PR",
        url: "https://github.com/acme/example/pull/42",
        baseBranch: "main",
        headBranch: "feature/shared",
        state: "open" as const,
      };
      const readModel = {
        ...makeReadModel([
          {
            ...makeThread("thread-refresh-a", "/tmp/worktree-a"),
            projectId: project.id,
            pullRequests: [{ pullRequest, source: "manual", linkedAt: timestamp }],
          },
          {
            ...makeThread("thread-refresh-b", "/tmp/worktree-b"),
            projectId: project.id,
            pullRequests: [{ pullRequest, source: "manual", linkedAt: timestamp }],
          },
        ]),
        projects: [project],
      };

      const groups = groupOpenPullRequestAssociationRefreshes(readModel);
      let resolveCalls = 0;
      for (const group of groups) {
        resolveCalls += 1;
        expect(group.pullRequest.url).toBe(pullRequest.url);
      }

      expect(resolveCalls).toBe(1);
      expect(groups[0]?.cwds).toEqual(["/tmp/worktree-a", "/tmp/project", "/tmp/worktree-b"]);
      expect(groups[0]?.candidates).toHaveLength(2);
    });

    it("falls back to another checkout when the first grouped refresh cwd fails", async () => {
      const calls: string[] = [];
      const pullRequest = {
        number: 42,
        title: "Shared PR",
        url: "https://github.com/acme/example/pull/42",
        baseBranch: "main",
        headBranch: "feature/shared",
        state: "open" as const,
      };

      const resolved = await Effect.runPromise(
        resolvePullRequestFromCwds(
          ["/tmp/unhealthy-worktree", "/tmp/healthy-worktree"],
          pullRequest.url,
          ({ cwd }) => {
            calls.push(cwd);
            return cwd === "/tmp/unhealthy-worktree"
              ? Effect.fail(
                  new GitManagerError({
                    operation: "test.resolvePullRequest",
                    detail: "checkout unavailable",
                  }),
                )
              : Effect.succeed({ pullRequest });
          },
        ),
      );

      expect(calls).toEqual(["/tmp/unhealthy-worktree", "/tmp/healthy-worktree"]);
      expect(resolved).toEqual({ pullRequest });
    });

    it("does not swallow resolver defects while trying fallback checkouts", async () => {
      const calls: string[] = [];
      const exit = await Effect.runPromiseExit(
        resolvePullRequestFromCwds(
          ["/tmp/defective-worktree", "/tmp/healthy-worktree"],
          "https://github.com/acme/example/pull/42",
          ({ cwd }) => {
            calls.push(cwd);
            return Effect.die("resolver defect");
          },
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toEqual(["/tmp/defective-worktree"]);
    });

    it("removes a clean archived merged-PR worktree from a disposable Git repository", async () => {
      await withCleanupFixture(
        {
          pullRequest: {
            number: 1,
            title: "Fixture",
            url: "https://github.com/example/repo/pull/1",
            baseBranch: "main",
            headBranch: "feature",
            state: "open",
          },
        },
        async (fixture) => {
          await fixture.start();

          expect(await fixture.jobStatus()).toBe("completed");
          expect(await fixture.registeredWorktrees()).not.toContain(fixture.worktreePath);
        },
      );
    });

    /**
     * Destructive-cleanup failure modes kept isolated in disposable Git/SQLite fixtures:
     * dirty content, pins, pending/running work, active runtimes, recent activity, shared
     * ownership, a cleanup reservation racing admission, and a branch checked out elsewhere.
     * Each must fail closed without moving user data or changing the persisted worktree path.
     */
    it("reclaims a clean idle worktree while retaining the branch and persisted path", async () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      await withCleanupFixture(
        {
          pullRequest: null,
          threadOverrides: { archivedAt: null, updatedAt: old, settledAt: old },
        },
        async (fixture) => {
          await writeFile(path.join(fixture.worktreePath, "committed.txt"), "kept in branch\n");
          await fixture.runGit(fixture.worktreePath, ["add", "committed.txt"]);
          await fixture.runGit(fixture.worktreePath, ["commit", "-m", "preserve idle commit"]);
          const head = (
            await fixture.runGit(fixture.repositoryRoot, ["rev-parse", "feature"])
          ).trim();
          const persistedPath = fixture.thread().worktreePath;

          await fixture.start();

          expect(await fixture.jobStatus()).toBe("completed");
          expect(existsSync(fixture.worktreePath)).toBe(false);
          expect(fixture.thread().worktreePath).toBe(persistedPath);
          expect(
            (await fixture.runGit(fixture.repositoryRoot, ["rev-parse", "feature"])).trim(),
          ).toBe(head);
          expect(fixture.activityCommands).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "thread.activity.append",
                activity: expect.objectContaining({
                  tone: "info",
                  summary: expect.stringContaining("7 days idle"),
                }),
              }),
            ]),
          );
        },
      );
    });

    it.each([
      ["dirty worktree", { archivedAt: null, updatedAt: "2000-01-01T00:00:00.000Z" }],
      [
        "pinned thread",
        {
          archivedAt: null,
          updatedAt: "2000-01-01T00:00:00.000Z",
          pinnedAt: "2000-01-01T00:00:00.000Z",
        },
      ],
      ["recent thread", { archivedAt: null, updatedAt: new Date().toISOString() }],
      [
        "running turn",
        {
          archivedAt: null,
          updatedAt: "2000-01-01T00:00:00.000Z",
          latestTurn: {
            state: "running",
            requestedAt: "2000-01-01T00:00:00.000Z",
            startedAt: null,
            completedAt: null,
            turnId: "turn-running",
            assistantMessageId: null,
          },
        },
      ],
      [
        "queued turn",
        {
          archivedAt: null,
          updatedAt: "2000-01-01T00:00:00.000Z",
          queuedTurns: [{ id: "queued-turn" }],
        },
      ],
    ] as const)("does not enqueue an idle cleanup for a %s", async (reason, overrides) => {
      const dirty = reason === "dirty worktree";
      await withCleanupFixture(
        { pullRequest: null, threadOverrides: overrides as Partial<FixtureThread> },
        async (fixture) => {
          if (dirty) await writeFile(path.join(fixture.worktreePath, "uncommitted.txt"), "keep\n");
          await fixture.start();

          expect(await fixture.jobStatus()).toBeUndefined();
          expect(existsSync(fixture.worktreePath)).toBe(true);
        },
      );
    });

    it("keeps idle worktrees with a running terminal subprocess", async () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      await withCleanupFixture(
        {
          pullRequest: null,
          threadOverrides: { archivedAt: null, updatedAt: old },
          terminalSummaries: [
            {
              threadId: "thread-cleanup-fixture",
              terminalId: "terminal-running",
              cwd: "/tmp",
              worktreePath: null,
              status: "running",
              pid: 123,
              exitCode: null,
              exitSignal: null,
              hasRunningSubprocess: true,
              label: "long-running task",
              updatedAt: old,
            },
          ],
        },
        async (fixture) => {
          await fixture.start();
          expect(await fixture.jobStatus()).toBeUndefined();
          expect(existsSync(fixture.worktreePath)).toBe(true);
        },
      );
    });

    it("keeps idle worktrees while the provider still owns an active session", async () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      await withCleanupFixture(
        {
          pullRequest: null,
          threadOverrides: { archivedAt: null, updatedAt: old },
          providerSessions: [{ threadId: "thread-cleanup-fixture" } as never],
        },
        async (fixture) => {
          await fixture.start();
          expect(await fixture.jobStatus()).toBeUndefined();
          expect(existsSync(fixture.worktreePath)).toBe(true);
        },
      );
    });

    it.each([
      ["pending approval", { pendingApprovalCount: 1 }],
      ["pending user input", { pendingUserInputCount: 1 }],
    ] as const)("keeps an idle worktree with %s", async (_reason, overrides) => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      await withCleanupFixture(
        {
          pullRequest: null,
          threadOverrides: { archivedAt: null, updatedAt: old },
          ...overrides,
        },
        async (fixture) => {
          await fixture.start();
          expect(await fixture.jobStatus()).toBeUndefined();
          expect(existsSync(fixture.worktreePath)).toBe(true);
        },
      );
    });

    it.each([
      [
        "latest user message",
        {
          messages: [
            {
              id: "message-recent-user",
              role: "user",
              text: "recent activity",
              turnId: null,
              streaming: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            } as never,
          ],
        },
      ],
      [
        "latest turn completion",
        {
          latestTurn: {
            turnId: "turn-recent",
            state: "completed",
            requestedAt: "2000-01-01T00:00:00.000Z",
            startedAt: "2000-01-01T00:00:00.000Z",
            completedAt: new Date().toISOString(),
            assistantMessageId: null,
          },
        },
      ],
    ] as const)("uses %s as recent activity", async (_reason, overrides) => {
      const old = "2000-01-01T00:00:00.000Z";
      await withCleanupFixture(
        {
          pullRequest: null,
          threadOverrides: {
            archivedAt: null,
            updatedAt: old,
            ...overrides,
          } as Partial<FixtureThread>,
        },
        async (fixture) => {
          await fixture.start();
          expect(await fixture.jobStatus()).toBeUndefined();
          expect(existsSync(fixture.worktreePath)).toBe(true);
        },
      );
    });

    it("keeps a canonical worktree path shared with another active thread", async () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      await withCleanupFixture(
        {
          pullRequest: null,
          threadOverrides: { archivedAt: null, updatedAt: old },
          additionalThreadFactory: (worktreePath, projectId) => [
            {
              ...makeThread("thread-shared-owner", worktreePath),
              projectId,
              archivedAt: null,
              updatedAt: old,
            },
          ],
        },
        async (fixture) => {
          await fixture.start();
          expect(await fixture.jobStatus()).toBeUndefined();
          expect(existsSync(fixture.worktreePath)).toBe(true);
        },
      );
    });

    it("does not reclaim idle worktrees when the setting is null", async () => {
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      await withCleanupFixture(
        {
          pullRequest: null,
          idleWorktreeReclaimDays: null,
          threadOverrides: { archivedAt: null, updatedAt: old },
        },
        async (fixture) => {
          await fixture.start();
          expect(await fixture.jobStatus()).toBeUndefined();
          expect(existsSync(fixture.worktreePath)).toBe(true);
        },
      );
    });

    it("removes a clean archived worktree without a pull request and keeps its branch commits", async () => {
      await withCleanupFixture({ pullRequest: null }, async (fixture) => {
        await writeFile(path.join(fixture.worktreePath, "work.txt"), "unmerged work\n");
        await fixture.runGit(fixture.worktreePath, ["add", "work.txt"]);
        await fixture.runGit(fixture.worktreePath, ["commit", "-m", "unmerged work"]);
        const featureHead = (
          await fixture.runGit(fixture.repositoryRoot, ["rev-parse", "feature"])
        ).trim();

        await fixture.start();

        expect(await fixture.jobStatus()).toBe("completed");
        expect(await fixture.registeredWorktrees()).not.toContain(fixture.worktreePath);
        expect(existsSync(fixture.worktreePath)).toBe(false);
        expect(await readdir(worktreeTrashDirectory(fixture.worktreePath))).toEqual([]);
        expect(
          (await fixture.runGit(fixture.repositoryRoot, ["rev-parse", "feature"])).trim(),
        ).toBe(featureHead);
      });
    });

    it("keeps an archived worktree with uncommitted work", async () => {
      await withCleanupFixture({ pullRequest: null }, async (fixture) => {
        const draftPath = path.join(fixture.worktreePath, "draft.txt");
        await writeFile(draftPath, "uncommitted\n");

        await fixture.start();

        expect(await fixture.jobStatus()).toBe("waiting");
        expect(await fixture.registeredWorktrees()).toContain(fixture.worktreePath);
        expect(await readFile(draftPath, "utf8")).toBe("uncommitted\n");
      });
    });

    it("restores a removed worktree on its branch and reruns setup when the chat is unarchived", async () => {
      await withCleanupFixture({ pullRequest: null }, async (fixture) => {
        await writeFile(path.join(fixture.worktreePath, "work.txt"), "unmerged work\n");
        await fixture.runGit(fixture.worktreePath, ["add", "work.txt"]);
        await fixture.runGit(fixture.worktreePath, ["commit", "-m", "unmerged work"]);

        await fixture.start();
        expect(await fixture.registeredWorktrees()).not.toContain(fixture.worktreePath);

        await fixture.unarchive();

        expect(await fixture.registeredWorktrees()).toContain(fixture.worktreePath);
        expect(
          (await fixture.runGit(fixture.worktreePath, ["branch", "--show-current"])).trim(),
        ).toBe("feature");
        await fixture.waitForSetupScript();
        expect(await readFile(path.join(fixture.worktreePath, "work.txt"), "utf8")).toBe(
          "unmerged work\n",
        );
        expect(fixture.setupScriptRuns).toEqual([fixture.worktreePath]);
        expect(fixture.dispatched).toEqual([]);
      });
    });

    it("restores an idle worktree on the same path and branch before admitting the next turn", async () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      await withCleanupFixture(
        {
          pullRequest: null,
          threadOverrides: { archivedAt: null, updatedAt: old },
        },
        async (fixture) => {
          await writeFile(path.join(fixture.worktreePath, "committed.txt"), "restore me\n");
          await fixture.runGit(fixture.worktreePath, ["add", "committed.txt"]);
          await fixture.runGit(fixture.worktreePath, ["commit", "-m", "restore on next turn"]);

          await fixture.start();
          expect(existsSync(fixture.worktreePath)).toBe(false);
          const admitted = await fixture.turnStart();

          expect(admitted.type).toBe("thread.turn.start");
          expect(existsSync(fixture.worktreePath)).toBe(true);
          expect(
            (await fixture.runGit(fixture.worktreePath, ["branch", "--show-current"])).trim(),
          ).toBe("feature");
          expect(await readFile(path.join(fixture.worktreePath, "committed.txt"), "utf8")).toBe(
            "restore me\n",
          );
          await fixture.waitForSetupScript();
          expect(fixture.setupScriptRuns).toEqual([fixture.worktreePath]);
        },
      );
    });

    it("cancels a waiting idle cleanup job when a turn starts", async () => {
      await withCleanupFixture(
        { pullRequest: null, threadOverrides: { archivedAt: null } },
        async (fixture) => {
          await fixture.enqueueIdleCleanup();

          await fixture.turnStart();

          expect(await fixture.jobStatus()).toBe("cancelled");
          expect(existsSync(fixture.worktreePath)).toBe(true);
        },
      );
    });

    it("blocks turn admission while an idle cleanup reservation is removing the worktree", async () => {
      await withCleanupFixture(
        { pullRequest: null, threadOverrides: { archivedAt: null } },
        async (fixture) => {
          await fixture.enqueueIdleCleanup();
          await fixture.reserveIdleCleanup();

          await expect(fixture.turnStart()).rejects.toThrow(/pending cleanup/i);

          expect(await fixture.jobStatus()).toBe("removing");
          expect(existsSync(fixture.worktreePath)).toBe(true);
        },
      );
    });

    it("does not restore a missing worktree while its cleanup job is already removing", async () => {
      await withCleanupFixture(
        { pullRequest: null, threadOverrides: { archivedAt: null } },
        async (fixture) => {
          await fixture.enqueueIdleCleanup();
          await fixture.reserveIdleCleanup();
          await rename(fixture.worktreePath, `${fixture.worktreePath}-detached`);

          await expect(fixture.turnStart()).rejects.toThrow(/pending cleanup/i);

          expect(await fixture.jobStatus()).toBe("removing");
          expect(existsSync(fixture.worktreePath)).toBe(false);
        },
      );
    });

    it("rejects restoration when the persisted branch is checked out elsewhere", async () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      await withCleanupFixture(
        {
          pullRequest: null,
          threadOverrides: { archivedAt: null, updatedAt: old },
        },
        async (fixture) => {
          await fixture.start();
          expect(existsSync(fixture.worktreePath)).toBe(false);
          const otherWorktree = path.join(path.dirname(fixture.worktreePath), "occupied-feature");
          await fixture.runGit(fixture.repositoryRoot, [
            "worktree",
            "add",
            otherWorktree,
            "feature",
          ]);

          await expect(fixture.turnStart()).rejects.toThrow(
            /branch 'feature'.*not checked out in another worktree/i,
          );
          expect(existsSync(fixture.worktreePath)).toBe(false);
          expect((await fixture.runGit(otherWorktree, ["branch", "--show-current"])).trim()).toBe(
            "feature",
          );
        },
      );
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
