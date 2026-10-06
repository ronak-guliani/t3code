import {
  CommandId,
  EventId,
  type GitResolvePullRequestResult,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadId,
} from "@t3tools/contracts";
import path from "node:path";

import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { sameThreadPullRequest, threadPullRequestKey } from "@t3tools/shared/threadPullRequests";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Stream,
} from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { CheckoutCoordinator, CheckoutCoordinatorLive } from "../../git/CheckoutCoordinator.ts";
import { GitManager, type GitManagerShape } from "../../git/Services/GitManager.ts";
import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { canonicalizeWorktreePath } from "../../git/worktreePaths.ts";
import { WorktreeCleanupJobRepositoryLive } from "../../persistence/Layers/WorktreeCleanupJobs.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import {
  type WorktreeCleanupJob,
  WorktreeCleanupJobRepository,
} from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { WorkspaceOwnershipRepository } from "../../persistence/Services/WorkspaceOwnership.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { StorageCleanupPolicy } from "../../storage/StorageCleanupPolicy.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { isRemovableArchiveWorktreePath } from "../archiveWorktreeCleanup.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  type ManualWorktreeReclaimOutcome,
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { findCanonicalActiveWorktreeOwner } from "../worktreeOwnership.ts";
import { restoreThreadWorktree } from "../restoreThreadWorktree.ts";
import {
  ThreadWorktreeRestorerRegistry,
  layer as ThreadWorktreeRestorerRegistryLayer,
} from "../Services/ThreadWorktreeRestorerRegistry.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;
type ThreadArchivedEvent = Extract<OrchestrationEvent, { type: "thread.archived" }>;
type ThreadUnarchivedEvent = Extract<OrchestrationEvent, { type: "thread.unarchived" }>;
type ThreadCleanupLifecycleEvent = ThreadDeletedEvent | ThreadArchivedEvent | ThreadUnarchivedEvent;
type PullRequestRefreshCandidate = {
  readonly thread: OrchestrationReadModel["threads"][number];
  readonly link: NonNullable<OrchestrationReadModel["threads"][number]["pullRequests"]>[number];
};

export type PullRequestRefreshGroup = {
  readonly cwds: ReadonlyArray<string>;
  readonly pullRequest: PullRequestRefreshCandidate["link"]["pullRequest"];
  readonly candidates: ReadonlyArray<PullRequestRefreshCandidate>;
};

export function resolvePullRequestFromCwds(
  cwds: ReadonlyArray<string>,
  reference: string,
  resolvePullRequest: GitManagerShape["resolvePullRequest"],
): Effect.Effect<GitResolvePullRequestResult | null, never> {
  const cwd = cwds[0];
  if (!cwd) {
    return Effect.succeed(null);
  }
  return resolvePullRequest({ cwd, reference }).pipe(
    Effect.catch((error) =>
      Effect.logDebug("pull request association resolver failed for checkout", {
        cwd,
        reference,
        error: error instanceof Error ? error.message : String(error),
      }).pipe(
        Effect.andThen(resolvePullRequestFromCwds(cwds.slice(1), reference, resolvePullRequest)),
      ),
    ),
  );
}

const MAX_WORKTREE_CLEANUP_ATTEMPTS = 5;
const CLEANUP_RECONCILIATION_INTERVAL = "5 minutes";
const CLEANUP_DUE_SWEEP_INTERVAL = "1 minute";
const CLEANUP_DUE_SWEEP_BATCH_LIMIT = 16;
const IDLE_WORKTREE_RECLAIM_INTERVAL = "30 minutes";
const MAX_IDLE_WORKTREE_CANDIDATES_PER_SWEEP = 32;

/** Sibling directory that holds detached worktrees until their bytes are deleted. */
export function worktreeTrashDirectory(canonicalWorktreePath: string): string {
  return path.join(path.dirname(canonicalWorktreePath), ".t3-worktree-trash");
}

export function groupOpenPullRequestAssociationRefreshes(
  readModel: OrchestrationReadModel,
): ReadonlyArray<PullRequestRefreshGroup> {
  const projectsById = new Map(
    readModel.projects
      .filter((project) => project.deletedAt === null)
      .map((project) => [project.id, project] as const),
  );
  const candidates = readModel.threads.flatMap((thread) => {
    if (thread.deletedAt !== null || thread.archivedAt !== null) return [];
    const links =
      thread.pullRequests ??
      (thread.pullRequest
        ? [
            {
              pullRequest: thread.pullRequest,
              source: "manual" as const,
              linkedAt: thread.updatedAt,
            },
          ]
        : []);
    return links
      .filter((link) => link.pullRequest.state !== "merged")
      .map((link) => ({ thread, link }));
  });
  const groups = new Map<string, Array<PullRequestRefreshCandidate>>();
  for (const candidate of candidates) {
    const project = projectsById.get(candidate.thread.projectId);
    if (!project) continue;
    const key = threadPullRequestKey(candidate.link.pullRequest);
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  return [...groups.values()].flatMap((group) => {
    const first = group[0];
    if (!first) return [];
    const cwds = [
      ...new Set(
        group.flatMap((candidate) => {
          const candidateProject = projectsById.get(candidate.thread.projectId);
          return [
            ...(candidate.thread.worktreePath ? [candidate.thread.worktreePath] : []),
            ...(candidateProject ? [candidateProject.workspaceRoot] : []),
          ];
        }),
      ),
    ];
    return [
      {
        cwds,
        pullRequest: first.link.pullRequest,
        candidates: group,
      },
    ];
  });
}

export const processAfterWorktreeReservation = <A, E1, R1, E2, R2>(
  withLock: (
    effect: Effect.Effect<Option.Option<A>, E1, R1>,
  ) => Effect.Effect<Option.Option<A>, E1, R1>,
  reserve: Effect.Effect<Option.Option<A>, E1, R1>,
  process: (reservation: A) => Effect.Effect<void, E2, R2>,
): Effect.Effect<void, E1 | E2, R1 | R2> =>
  withLock(reserve).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: process,
      }),
    ),
  );

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

export const runAfterThreadRuntimeTeardown = <A, E1, R1, E2, R2, E3, R3>(
  stopProviderSession: Effect.Effect<void, E1, R1>,
  closeThreadTerminals: Effect.Effect<void, E2, R2>,
  effect: Effect.Effect<A, E3, R3>,
) =>
  Effect.gen(function* () {
    const [providerExit, terminalExit] = yield* Effect.all(
      [Effect.exit(stopProviderSession), Effect.exit(closeThreadTerminals)] as const,
      { concurrency: "unbounded" },
    );
    if (Exit.isFailure(providerExit)) {
      return yield* Effect.failCause(providerExit.cause);
    }
    if (Exit.isFailure(terminalExit)) {
      return yield* Effect.failCause(terminalExit.cause);
    }
    return yield* effect;
  });

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager;
  const git = yield* GitCore;
  const checkoutCoordinator = yield* CheckoutCoordinator;
  const gitManager = yield* GitManager;
  const gitStatusBroadcaster = yield* GitStatusBroadcaster;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
  const threadWorktreeRestorer = yield* ThreadWorktreeRestorerRegistry;
  const projectionThreads = yield* ProjectionThreadRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const worktreeCleanupJobs = yield* WorktreeCleanupJobRepository;
  const workspaceOwnership = yield* WorkspaceOwnershipRepository;
  const initialIdleSweepDone = yield* Deferred.make<void>();
  let idleSweepOffset = 0;

  const worktreeRestoreDependencies = {
    git,
    checkoutCoordinator,
    projectSetupScriptRunner,
  } as const;
  yield* threadWorktreeRestorer.register((input) =>
    restoreThreadWorktree(worktreeRestoreDependencies, input),
  );

  const storagePolicy = yield* StorageCleanupPolicy;

  // Archive and idle reclaim are automatic cleanup; user-requested deletion
  // cleanup and recovery of an in-progress removal are not paused.
  const automaticCleanupEnabled = Effect.map(
    storagePolicy.current,
    (policy) => policy.automaticCleanupEnabled,
  );

  const stopActiveProviderSession = Effect.fn("stopActiveProviderSession")(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) {
    yield* providerService.stopSession({ threadId });
  });

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: stopActiveProviderSession(threadId),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminalsEffect = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    terminalManager.close({ threadId, deleteHistory: true });

  // Runs outside every lock: the checkout is already detached from Git, so a
  // failure only leaves bytes for the startup trash sweep to reclaim.
  const deleteDetachedWorktree = (detachedPath: string) =>
    fileSystem.remove(detachedPath, { recursive: true, force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete detached worktree; startup sweep will retry", {
          detachedPath,
          error: error.message,
        }),
      ),
    );

  const sweepWorktreeTrash = Effect.gen(function* () {
    const jobs = yield* worktreeCleanupJobs.list();
    const trashDirectories = new Set(
      jobs.map((job) => worktreeTrashDirectory(job.canonicalWorktreePath)),
    );
    yield* Effect.forEach(
      trashDirectories,
      (trashDirectory) =>
        fileSystem.readDirectory(trashDirectory).pipe(
          Effect.catch(() => Effect.succeed([] as Array<string>)),
          // Only entries present now: concurrent cleanups detach under fresh names.
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries,
              (entry) => deleteDetachedWorktree(path.join(trashDirectory, entry)),
              { concurrency: 1, discard: true },
            ),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("worktree trash sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: closeThreadTerminalsEffect(threadId),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const releaseThreadOwnership = Effect.fn("releaseThreadOwnership")(function* (
    threadId: ThreadId,
  ) {
    const ownerships = yield* workspaceOwnership.getByThreadId(threadId);
    yield* Effect.forEach(
      ownerships,
      (ownership) => workspaceOwnership.release(threadId, ownership.canonicalPath),
      { concurrency: 1, discard: true },
    );
  });

  const cleanupNow = Effect.fn("cleanupNow")(function* () {
    return new Date(yield* Clock.currentTimeMillis).toISOString();
  });

  const cleanupRetryAt = Effect.fn("cleanupRetryAt")(function* (attemptCount: number) {
    const delaySeconds = Math.min(30 * 60, 60 * 2 ** Math.min(attemptCount, 5));
    return new Date((yield* Clock.currentTimeMillis) + delaySeconds * 1000).toISOString();
  });

  // Threads being reclaimed by "Clean up now": a reset ignores the age
  // threshold but keeps every other eligibility rule, at every re-check.
  const manualIdleReclaims = new Set<ThreadId>();
  const currentIdleReclaimDays = Effect.map(
    storagePolicy.current,
    (policy) => policy.idleWorktreeReclaimDays,
  );
  const idleReclaimDaysFor = (threadId: ThreadId) =>
    manualIdleReclaims.has(threadId) ? Effect.succeed(0) : currentIdleReclaimDays;

  const runtimeSafetySnapshot = Effect.gen(function* () {
    const providerSessions = yield* providerService.listSessions();
    const activeProviderThreadIds = new Set(providerSessions.map((session) => session.threadId));
    const runningTerminalThreadIds = new Set<ThreadId>();
    const terminalStates = new Map<
      string,
      { readonly threadId: ThreadId; readonly running: boolean }
    >();
    const refreshRunningTerminalThreads = () => {
      runningTerminalThreadIds.clear();
      for (const terminal of terminalStates.values()) {
        if (terminal.running) runningTerminalThreadIds.add(terminal.threadId);
      }
    };
    const unsubscribe = yield* terminalManager.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          terminalStates.clear();
          for (const terminal of event.terminals) {
            terminalStates.set(terminal.terminalId, {
              threadId: terminal.threadId as ThreadId,
              running: terminal.status === "running" && terminal.hasRunningSubprocess,
            });
          }
          refreshRunningTerminalThreads();
        } else if (event.type === "upsert") {
          const terminal = event.terminal;
          terminalStates.set(terminal.terminalId, {
            threadId: terminal.threadId as ThreadId,
            running: terminal.status === "running" && terminal.hasRunningSubprocess,
          });
          refreshRunningTerminalThreads();
        } else {
          terminalStates.delete(event.terminalId);
          refreshRunningTerminalThreads();
        }
      }),
    );
    yield* Effect.sync(unsubscribe);
    return { activeProviderThreadIds, runningTerminalThreadIds };
  });

  const latestThreadActivityMillis = (
    thread: OrchestrationReadModel["threads"][number],
    projectedLatestUserMessageAt?: string | null,
  ) => {
    const timestamps = [
      thread.updatedAt,
      thread.latestTurn?.completedAt ?? null,
      projectedLatestUserMessageAt ?? null,
      ...thread.messages
        .filter((message) => message.role === "user")
        .map((message) => message.createdAt),
    ]
      .filter((value): value is string => value !== null)
      .map((value) => Date.parse(value))
      .filter(Number.isFinite);
    return timestamps.length === 0 ? null : Math.max(...timestamps);
  };

  const isIdleWorktreeEligible = Effect.fn("isIdleWorktreeEligible")(function* (input: {
    readonly thread: OrchestrationReadModel["threads"][number];
    readonly project: OrchestrationReadModel["projects"][number];
    readonly readModel: OrchestrationReadModel;
    readonly idleDays: number | null;
    readonly nowMs: number;
    readonly runtime: {
      readonly activeProviderThreadIds: ReadonlySet<ThreadId>;
      readonly runningTerminalThreadIds: ReadonlySet<ThreadId>;
    };
    readonly checkClean: boolean;
  }) {
    const { thread, project, readModel, idleDays, nowMs, runtime } = input;
    if (
      idleDays === null ||
      !Number.isFinite(idleDays) ||
      idleDays < 0 ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.pinnedAt != null ||
      thread.worktreePath === null ||
      thread.branch === null ||
      project.deletedAt !== null ||
      thread.latestTurn?.state === "running" ||
      thread.session?.activeTurnId != null ||
      thread.session?.status === "starting" ||
      thread.session?.status === "running" ||
      thread.session?.status === "ready" ||
      (thread.queuedTurns?.length ?? 0) > 0 ||
      thread.collaborationRequests?.some(
        (request) =>
          request.blocking &&
          ["waiting", "notification-delivered", "response-ready"].includes(request.status),
      ) ||
      runtime.activeProviderThreadIds.has(thread.id) ||
      runtime.runningTerminalThreadIds.has(thread.id)
    ) {
      return false;
    }

    const projection = yield* projectionThreads.getById({ threadId: thread.id });
    if (
      Option.isNone(projection) ||
      projection.value.pendingApprovalCount > 0 ||
      projection.value.pendingUserInputCount > 0
    ) {
      return false;
    }

    const lastActivity = latestThreadActivityMillis(thread, projection.value.latestUserMessageAt);
    if (lastActivity === null || nowMs - lastActivity < idleDays * 24 * 60 * 60 * 1000) {
      return false;
    }

    const canonicalPath = yield* Effect.promise(() =>
      canonicalizeWorktreePath(thread.worktreePath!),
    );
    const canonicalWorkspaceRoot = yield* Effect.promise(() =>
      canonicalizeWorktreePath(project.workspaceRoot),
    );
    if (
      !isRemovableArchiveWorktreePath({
        canonicalWorktreePath: canonicalPath,
        canonicalWorkspaceRoot,
      }) ||
      Option.isSome(yield* findCanonicalActiveWorktreeOwner(readModel, thread.id, canonicalPath))
    ) {
      return false;
    }

    if (input.checkClean) {
      if (!(yield* fileSystem.exists(canonicalPath))) return false;
      if (!(yield* git.isWorktreeCleanForRemoval(canonicalPath))) return false;
    }
    return true;
  });

  const deferCleanup = Effect.fn("deferCleanup")(function* (
    threadId: ThreadId,
    reason: string,
    error?: string,
    attemptCount = 0,
  ) {
    yield* worktreeCleanupJobs.defer({
      threadId,
      reason,
      error,
      nextAttemptAt: yield* cleanupRetryAt(attemptCount),
    });
  });

  const inspectRegisteredWorktree = Effect.fn("inspectRegisteredWorktree")(function* (
    cleanup: WorktreeCleanupJob,
  ) {
    const branches = yield* checkoutCoordinator.withCheckout(
      cleanup.cwd,
      git.listRegisteredWorktrees(cleanup.cwd),
    );
    if (!branches.isRepo) {
      return { isRepo: false, registered: false, branchName: null };
    }
    const registeredWorktrees = yield* Effect.forEach(
      branches.worktrees,
      ({ branch, path }) =>
        Effect.promise(() => canonicalizeWorktreePath(path)).pipe(
          Effect.map((canonicalPath) => ({ branch, path: canonicalPath })),
        ),
      { concurrency: 4 },
    );
    const registeredWorktree = registeredWorktrees.find(
      ({ path }) => path === cleanup.canonicalWorktreePath,
    );
    return {
      isRepo: true,
      registered: registeredWorktree !== undefined,
      branchName: registeredWorktree?.branch ?? null,
    };
  });

  const reconcileCleanupIntent = Effect.fn("reconcileCleanupIntent")(function* (
    threadId: ThreadId,
  ) {
    const cleanupOption = yield* worktreeCleanupJobs.getByThreadId(threadId);
    if (Option.isNone(cleanupOption) || cleanupOption.value.status !== "waiting") {
      return false;
    }
    const cleanup = cleanupOption.value;
    const now = yield* cleanupNow();
    if (cleanup.nextAttemptAt !== null && cleanup.nextAttemptAt > now) {
      return false;
    }
    if (cleanup.source === "legacy") {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: "legacy-cleanup-intent-requires-review",
      });
      return false;
    }

    const canonicalPath = yield* Effect.promise(() =>
      canonicalizeWorktreePath(cleanup.worktreePath),
    );
    if (canonicalPath !== cleanup.canonicalWorktreePath) {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: "canonical-path-changed",
      });
      return false;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const cleanupThread = readModel.threads.find((thread) => thread.id === threadId);
    const project = cleanupThread
      ? readModel.projects.find((entry) => entry.id === cleanupThread.projectId)
      : readModel.projects.find(
          (entry) => entry.workspaceRoot === cleanup.cwd && entry.deletedAt === null,
        );
    if (project === undefined || project.deletedAt !== null) {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: project === undefined ? "project-not-found" : "project-deleted",
      });
      return false;
    }

    const canonicalWorkspaceRoot = yield* Effect.promise(() =>
      canonicalizeWorktreePath(cleanup.cwd),
    );
    if (
      !isRemovableArchiveWorktreePath({
        canonicalWorktreePath: cleanup.canonicalWorktreePath,
        canonicalWorkspaceRoot,
      })
    ) {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: "project-workspace-root",
      });
      return false;
    }

    if (cleanup.source === "archive") {
      if (cleanupThread?.deletedAt !== null && cleanupThread !== undefined) {
        yield* worktreeCleanupJobs.markNeedsAttention({
          threadId,
          reason: "archived-thread-was-deleted",
        });
        return false;
      }
      if (cleanupThread?.archivedAt === null || cleanupThread === undefined) {
        yield* worktreeCleanupJobs.cancelByThreadId(threadId);
        return false;
      }
      // Pull request state is deliberately irrelevant: removal keeps the
      // branch ref (so commits survive), refuses dirty or untracked work, and
      // unarchive restores the checkout from that branch.
    }
    if (cleanup.source === "idle") {
      if (
        cleanupThread === undefined ||
        cleanupThread.archivedAt !== null ||
        cleanupThread.deletedAt !== null
      ) {
        yield* worktreeCleanupJobs.cancelIdleByThreadId(threadId);
        return false;
      }
      const [idleDays, runtime] = yield* Effect.all([
        idleReclaimDaysFor(threadId),
        runtimeSafetySnapshot,
      ]);
      if (
        !(yield* isIdleWorktreeEligible({
          thread: cleanupThread,
          project,
          readModel,
          idleDays,
          nowMs: Date.parse(now),
          runtime,
          checkClean: false,
        }))
      ) {
        yield* worktreeCleanupJobs.cancelIdleByThreadId(threadId);
        return false;
      }
    }

    const registration = yield* inspectRegisteredWorktree(cleanup);
    const exists = yield* fileSystem.exists(cleanup.canonicalWorktreePath);
    if (!registration.isRepo) {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: "repository-unavailable",
      });
      return false;
    }
    if (!registration.registered && !exists) {
      yield* worktreeCleanupJobs.markCompletedWithoutRemoval({ threadId });
      return false;
    }
    if (!registration.registered) {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: "worktree-not-registered-in-expected-repository",
      });
      return false;
    }
    if (
      cleanupThread?.branch === null ||
      cleanupThread?.branch === undefined ||
      registration.branchName !== cleanupThread.branch
    ) {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: "worktree-branch-mismatch",
      });
      return false;
    }
    return true;
  });

  const reserveCleanup = Effect.fn("reserveCleanup")(function* (threadId: ThreadId) {
    const cleanupOption = yield* worktreeCleanupJobs.getByThreadId(threadId);
    if (Option.isNone(cleanupOption) || cleanupOption.value.status !== "waiting") {
      return Option.none<{
        readonly cleanup: WorktreeCleanupJob;
        readonly canonicalPath: string;
        readonly siblingThreadIds: ReadonlyArray<ThreadId>;
      }>();
    }
    const cleanup = cleanupOption.value;
    const now = yield* cleanupNow();
    if (cleanup.nextAttemptAt !== null && cleanup.nextAttemptAt > now) {
      return Option.none();
    }
    const canonicalPath = yield* Effect.promise(() =>
      canonicalizeWorktreePath(cleanup.worktreePath),
    );
    const readModel = yield* orchestrationEngine.getReadModel();
    const cleanupThread = readModel.threads.find((thread) => thread.id === threadId);
    if (
      cleanup.source === "archive" &&
      (cleanupThread === undefined || cleanupThread.archivedAt === null)
    ) {
      yield* worktreeCleanupJobs.cancelByThreadId(threadId);
      return Option.none();
    }
    if (cleanup.source === "delete" && cleanupThread?.deletedAt === null) {
      yield* worktreeCleanupJobs.cancelByThreadId(threadId);
      return Option.none();
    }

    const activeOwner = yield* findCanonicalActiveWorktreeOwner(readModel, threadId, canonicalPath);
    if (Option.isSome(activeOwner)) {
      yield* deferCleanup(threadId, "active-worktree-owner", undefined, cleanup.attemptCount);
      return Option.none();
    }

    if (cleanup.source === "idle") {
      const project =
        cleanupThread === undefined
          ? undefined
          : readModel.projects.find((entry) => entry.id === cleanupThread.projectId);
      const [configuredDays, runtime] = yield* Effect.all([
        idleReclaimDaysFor(threadId),
        runtimeSafetySnapshot,
      ]);
      if (
        cleanupThread === undefined ||
        project === undefined ||
        !(yield* isIdleWorktreeEligible({
          thread: cleanupThread,
          project,
          readModel,
          idleDays: configuredDays,
          nowMs: Date.parse(now),
          runtime,
          checkClean: false,
        }))
      ) {
        yield* worktreeCleanupJobs.cancelIdleByThreadId(threadId);
        return Option.none();
      }
    }

    // Under the per-checkout lock a turn start also holds while checking, so
    // "observe no reservation" and "create it" are mutually exclusive. The
    // global lock no longer covers this since turn starts stopped taking it.
    const reservation = yield* checkoutCoordinator.withCheckout(
      canonicalPath,
      worktreeCleanupJobs.tryReserveForRemoval({
        threadId,
        canonicalWorktreePath: canonicalPath,
        reservedAt: now,
      }),
    );
    if (Option.isNone(reservation)) {
      return Option.none();
    }

    const siblingThreadIds = yield* Effect.forEach(
      readModel.threads.filter(
        (thread) =>
          thread.id !== threadId &&
          thread.worktreePath !== null &&
          (thread.archivedAt !== null || thread.deletedAt !== null),
      ),
      (thread) =>
        Effect.promise(() => canonicalizeWorktreePath(thread.worktreePath!)).pipe(
          Effect.map((path) => (path === canonicalPath ? thread.id : null)),
        ),
      { concurrency: 4 },
    ).pipe(Effect.map((ids) => ids.filter((id): id is ThreadId => id !== null)));

    return Option.some({
      cleanup: reservation.value.cleanup,
      canonicalPath,
      siblingThreadIds,
    });
  });

  const runReservedCleanup = ({
    cleanup,
    canonicalPath,
    siblingThreadIds,
  }: {
    readonly cleanup: WorktreeCleanupJob;
    readonly canonicalPath: string;
    readonly siblingThreadIds: ReadonlyArray<ThreadId>;
  }) =>
    Effect.gen(function* () {
      if (siblingThreadIds.length > 0) {
        yield* Effect.forEach(
          siblingThreadIds,
          (siblingThreadId) =>
            Effect.all(
              [
                stopActiveProviderSession(siblingThreadId),
                closeThreadTerminalsEffect(siblingThreadId),
              ] as const,
              { concurrency: "unbounded", discard: true },
            ),
          { concurrency: 4, discard: true },
        );
      }

      const preflight = yield* orchestrationEngine.withWorktreeLock(
        Effect.gen(function* () {
          const readModel = yield* orchestrationEngine.getReadModel();
          const activeOwner = yield* findCanonicalActiveWorktreeOwner(
            readModel,
            cleanup.threadId,
            canonicalPath,
          );
          const cleanupThread = readModel.threads.find((thread) => thread.id === cleanup.threadId);
          if (cleanupThread === undefined) {
            yield* worktreeCleanupJobs.markNeedsAttention({
              threadId: cleanup.threadId,
              reason: "thread-not-found",
            });
            return null;
          }
          if (
            Option.isSome(activeOwner) ||
            (cleanup.source === "archive" && cleanupThread.archivedAt === null)
          ) {
            yield* worktreeCleanupJobs.markNeedsAttention({
              threadId: cleanup.threadId,
              reason: Option.isSome(activeOwner) ? "active-worktree-owner" : "owner-reopened",
            });
            return null;
          }
          let currentIdleDays: number | null = null;
          if (cleanup.source === "idle") {
            const project = readModel.projects.find(
              (entry) => entry.id === cleanupThread.projectId,
            );
            const [configuredDays, runtime] = yield* Effect.all([
              idleReclaimDaysFor(cleanup.threadId),
              runtimeSafetySnapshot,
            ]);
            if (
              project === undefined ||
              !(yield* isIdleWorktreeEligible({
                thread: cleanupThread,
                project,
                readModel,
                idleDays: configuredDays,
                nowMs: yield* Clock.currentTimeMillis,
                runtime,
                checkClean: false,
              }))
            ) {
              const now = yield* cleanupNow();
              yield* worktreeCleanupJobs.recoverRemoving({
                threadId: cleanup.threadId,
                nextAttemptAt: now,
                reason: "idle-worktree-no-longer-eligible",
              });
              yield* worktreeCleanupJobs.cancelIdleByThreadId(cleanup.threadId);
              return null;
            }
            currentIdleDays = configuredDays;
          }
          return { branch: cleanupThread.branch, idleDays: currentIdleDays };
        }),
      );
      if (preflight === null) {
        return;
      }

      // Git status can enumerate every untracked file. The durable removing
      // reservation blocks admission while this read runs, so keep the
      // repository checkout lock reserved for the brief detach/prune sequence.
      if (!(yield* git.isWorktreeCleanForRemoval(canonicalPath))) {
        yield* deferCleanup(cleanup.threadId, "dirty-worktree", undefined, cleanup.attemptCount);
        return;
      }

      const detachedPath = yield* checkoutCoordinator.withCheckout(
        cleanup.cwd,
        Effect.gen(function* () {
          const registeredWorktrees = yield* git.listRegisteredWorktrees(cleanup.cwd);
          if (!registeredWorktrees.isRepo) {
            yield* worktreeCleanupJobs.markNeedsAttention({
              threadId: cleanup.threadId,
              reason: "repository-unavailable",
            });
            return null;
          }
          const canonicalWorktrees = yield* Effect.forEach(
            registeredWorktrees.worktrees,
            ({ branch, path }) =>
              Effect.promise(() => canonicalizeWorktreePath(path)).pipe(
                Effect.map((canonicalRegisteredPath) => ({
                  branch,
                  path: canonicalRegisteredPath,
                })),
              ),
            { concurrency: 4 },
          );
          const registeredWorktree = canonicalWorktrees.find(({ path }) => path === canonicalPath);
          const exists = yield* fileSystem.exists(canonicalPath);
          if (!exists) {
            // Nothing left on disk to lose (including a crash after detaching);
            // prune drops any stale registration.
            yield* git.pruneWorktrees(cleanup.cwd);
            yield* worktreeCleanupJobs.markCompleted({ threadId: cleanup.threadId });
            return null;
          }
          if (registeredWorktree === undefined) {
            yield* worktreeCleanupJobs.markNeedsAttention({
              threadId: cleanup.threadId,
              reason: "worktree-registration-mismatch",
            });
            return null;
          }
          if (preflight.branch === null || registeredWorktree.branch !== preflight.branch) {
            yield* worktreeCleanupJobs.markNeedsAttention({
              threadId: cleanup.threadId,
              reason: "worktree-branch-mismatch",
            });
            return null;
          }
          // Detach with an O(1) rename so the repository checkout lock is not held
          // while multi-gigabyte dependency trees are deleted. The branch ref is
          // untouched, so committed work stays reachable.
          const trashPath = path.join(
            worktreeTrashDirectory(canonicalPath),
            `${path.basename(canonicalPath)}-${crypto.randomUUID()}`,
          );
          yield* fileSystem.makeDirectory(path.dirname(trashPath), { recursive: true });
          yield* fileSystem.rename(canonicalPath, trashPath);
          yield* git.pruneWorktrees(cleanup.cwd);
          yield* worktreeCleanupJobs.markCompleted({ threadId: cleanup.threadId });
          yield* gitStatusBroadcaster
            .refreshStatus(cleanup.cwd)
            .pipe(Effect.ignoreCause({ log: true }));
          yield* Effect.logInfo("removed reconciled worktree", {
            threadId: cleanup.threadId,
            worktreePath: canonicalPath,
            source: cleanup.source,
            reason:
              cleanup.source === "idle"
                ? `idle-worktree-reclaimed-after-${preflight.idleDays}-days`
                : cleanup.source,
          });
          return trashPath;
        }),
      );
      if (detachedPath !== null) {
        yield* deleteDetachedWorktree(detachedPath);
        if (cleanup.source === "idle" && preflight.idleDays !== null) {
          const createdAt = yield* cleanupNow();
          const days = preflight.idleDays;
          yield* orchestrationEngine
            .dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(crypto.randomUUID()),
              threadId: cleanup.threadId,
              createdAt,
              activity: {
                id: EventId.make(crypto.randomUUID()),
                kind: "worktree.reclaimed",
                tone: "info",
                summary:
                  days === 0
                    ? "Worktree reclaimed by Clean up now; it will be restored on your next message."
                    : `Worktree reclaimed after ${days} days idle; it will be restored on your next message.`,
                payload: { daysIdle: days, branch: preflight.branch },
                turnId: null,
                createdAt,
              },
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to append idle worktree reclaim activity", {
                  threadId: cleanup.threadId,
                  worktreePath: canonicalPath,
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            );
        }
      }
    });

  const processWorktreeCleanup = Effect.fn("processWorktreeCleanup")(function* (
    threadId: ThreadId,
  ) {
    if (!(yield* reconcileCleanupIntent(threadId))) {
      return;
    }
    yield* processAfterWorktreeReservation(
      orchestrationEngine.withWorktreeLock,
      reserveCleanup(threadId),
      (reservation) => {
        const cleanupEffect = runReservedCleanup(reservation).pipe(
          Effect.flatMap(() => worktreeCleanupJobs.getByThreadId(threadId)),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (job) =>
                job.status === "completed" && job.source !== "idle"
                  ? releaseThreadOwnership(threadId)
                  : Effect.void,
            }),
          ),
        );
        return reservation.cleanup.source === "idle"
          ? cleanupEffect
          : runAfterThreadRuntimeTeardown(
              stopActiveProviderSession(threadId),
              closeThreadTerminalsEffect(threadId),
              cleanupEffect,
            );
      },
    );
  });

  const recordWorktreeCleanupFailure = (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
    cause: Cause.Cause<unknown>,
  ) =>
    Effect.gen(function* () {
      const job = yield* worktreeCleanupJobs.getByThreadId(threadId);
      const now = yield* cleanupNow();
      const nextAttemptAt = Option.isSome(job)
        ? yield* cleanupRetryAt(job.value.attemptCount)
        : now;
      return yield* worktreeCleanupJobs
        .recordFailure({
          threadId,
          error: Cause.pretty(cause),
          now,
          nextAttemptAt,
          maxAttempts: MAX_WORKTREE_CLEANUP_ATTEMPTS,
        })
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (result) =>
                result.status === "needs-attention"
                  ? Effect.logError(
                      "worktree cleanup requires manual review after repeated failures",
                      {
                        threadId,
                        attemptCount: result.attemptCount,
                        cause: Cause.pretty(cause),
                      },
                    )
                  : Effect.logWarning("worktree cleanup failed and will retry", {
                      threadId,
                      attemptCount: result.attemptCount,
                      cause: Cause.pretty(cause),
                    }),
            }),
          ),
          Effect.catch((recordError) =>
            Effect.logError("failed to record worktree cleanup failure", {
              threadId,
              cleanupCause: Cause.pretty(cause),
              recordError: recordError.message,
            }),
          ),
        );
    });

  const queuedWorktreeCleanups = new Set<ThreadDeletedEvent["payload"]["threadId"]>();
  const cleanupWaiters = new Map<ThreadId, Array<Deferred.Deferred<void>>>();
  const worktreeCleanupWorker = yield* makeDrainableWorker(
    (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
      processWorktreeCleanup(threadId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return recordWorktreeCleanupFailure(threadId, cause);
        }),
        Effect.ensuring(
          Effect.suspend(() => {
            queuedWorktreeCleanups.delete(threadId);
            const waiters = cleanupWaiters.get(threadId) ?? [];
            cleanupWaiters.delete(threadId);
            return Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), {
              discard: true,
            });
          }),
        ),
      ),
  );
  const enqueueWorktreeCleanup = (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      if (queuedWorktreeCleanups.has(threadId)) {
        return false;
      }
      queuedWorktreeCleanups.add(threadId);
      return true;
    }).pipe(
      Effect.flatMap((shouldEnqueue) =>
        shouldEnqueue ? worktreeCleanupWorker.enqueue(threadId) : Effect.void,
      ),
      Effect.uninterruptible,
    );

  const cancelPendingCleanupForThreadAndPath = Effect.fn("cancelPendingCleanupForThreadAndPath")(
    function* (threadId: ThreadId, worktreePath: string | null) {
      yield* worktreeCleanupJobs.cancelByThreadId(threadId);
      if (worktreePath === null) {
        return;
      }
      const canonicalPath = yield* Effect.promise(() => canonicalizeWorktreePath(worktreePath));
      const jobs = yield* worktreeCleanupJobs.list();
      yield* Effect.forEach(
        jobs,
        (job) =>
          Effect.promise(() => canonicalizeWorktreePath(job.worktreePath)).pipe(
            Effect.flatMap((pendingPath) =>
              pendingPath === canonicalPath
                ? worktreeCleanupJobs.cancelByThreadId(job.threadId)
                : Effect.void,
            ),
          ),
        { concurrency: 4, discard: true },
      );
    },
  );

  const persistArchiveCleanupIntent = Effect.fn("persistArchiveCleanupIntent")(function* (
    threadId: ThreadId,
    allowTerminalReset: boolean,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (thread === undefined || thread.worktreePath === null) {
      return null;
    }
    const project = readModel.projects.find((entry) => entry.id === thread.projectId);
    if (project === undefined) {
      return null;
    }

    const requestedAt = yield* cleanupNow();
    const canonicalWorktreePath = yield* Effect.promise(() =>
      canonicalizeWorktreePath(thread.worktreePath!),
    );
    const job = yield* worktreeCleanupJobs
      .enqueue({
        threadId,
        cwd: project.workspaceRoot,
        worktreePath: thread.worktreePath,
        canonicalWorktreePath,
        requestedAt,
        source: "archive",
        allowTerminalReset,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logDebug("archive worktree cleanup intent not persisted", {
            threadId,
            worktreePath: canonicalWorktreePath,
            error: error instanceof Error ? error.message : String(error),
          }).pipe(Effect.as(null)),
        ),
      );
    return job === null ? null : { job, requestedAt, canonicalWorktreePath };
  });

  const enqueueArchiveCleanupIntent = Effect.fn("enqueueArchiveCleanupIntent")(function* (
    threadId: ThreadId,
    allowTerminalReset = false,
  ) {
    const persisted = yield* persistArchiveCleanupIntent(threadId, allowTerminalReset);
    if (persisted === null) {
      return;
    }
    const { job, requestedAt, canonicalWorktreePath } = persisted;
    if (
      job.status !== "waiting" ||
      (job.nextAttemptAt !== null && job.nextAttemptAt > requestedAt)
    ) {
      return;
    }
    if (!(yield* automaticCleanupEnabled)) {
      // The intent stays durable; the due sweep picks it up once re-enabled.
      yield* Effect.logDebug("archive worktree cleanup paused by automatic-cleanup switch", {
        threadId,
      });
      return;
    }
    yield* enqueueWorktreeCleanup(threadId);
    yield* Effect.logInfo("queued archive worktree cleanup reconciliation", {
      threadId,
      worktreePath: canonicalWorktreePath,
    });
  });

  const processThreadUnarchived = Effect.fn("processThreadUnarchived")(function* (
    event: ThreadUnarchivedEvent,
  ) {
    const { threadId } = event.payload;
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    const worktreePath = thread?.worktreePath ?? null;
    yield* cancelPendingCleanupForThreadAndPath(threadId, worktreePath);

    if (worktreePath === null) {
      return;
    }
    const canonicalPath = yield* Effect.promise(() => canonicalizeWorktreePath(worktreePath));
    const stillExists = yield* fileSystem.exists(canonicalPath);
    if (stillExists) {
      return;
    }

    // Archive cleanup removes clean checkouts but keeps their branch, so bring
    // the chat back on the same branch and path instead of losing its workspace.
    const project = thread
      ? readModel.projects.find((entry) => entry.id === thread.projectId)
      : undefined;
    if (thread?.branch && project !== undefined && project.deletedAt === null) {
      const restored = yield* restoreThreadWorktree(worktreeRestoreDependencies, {
        threadId,
        projectId: project.id,
        projectCwd: project.workspaceRoot,
        worktreePath,
        branch: thread.branch,
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("failed to restore archived worktree on unarchive", {
            threadId,
            worktreePath: canonicalPath,
            error: error instanceof Error ? error.message : String(error),
          }).pipe(Effect.as(false)),
        ),
      );
      if (restored) {
        return;
      }
    }

    // Clear the orchestration read model via a domain event so later bindings
    // don't treat a missing path as still owned by this thread.
    yield* orchestrationEngine
      .dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(crypto.randomUUID()),
        threadId,
        worktreePath: null,
        workspaceBinding: null,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to clear missing worktreePath after unarchive", {
            threadId,
            worktreePath: canonicalPath,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
  });

  const processThreadLifecycleEvent = Effect.fn("processThreadLifecycleEvent")(function* (
    event: ThreadCleanupLifecycleEvent,
  ) {
    if (event.type === "thread.unarchived") {
      yield* processThreadUnarchived(event);
      return;
    }

    const { threadId } = event.payload;
    if (event.type === "thread.deleted" && event.payload.worktreeCleanup !== undefined) {
      // Cleanup worker tears down this thread, then any inactive path siblings,
      // before removing the checkout.
      yield* enqueueWorktreeCleanup(threadId);
      return;
    }

    // Always tear down archived/deleted threads, even without a cleanup reservation.
    // Otherwise a sibling that reserved cleanup can delete a shared checkout
    // while this thread's provider/terminals are still attached.
    if (event.type === "thread.deleted") {
      yield* runAfterThreadRuntimeTeardown(
        stopActiveProviderSession(threadId),
        closeThreadTerminalsEffect(threadId),
        releaseThreadOwnership(threadId),
      );
    } else {
      yield* Effect.all([stopProviderSession(threadId), closeThreadTerminals(threadId)], {
        concurrency: "unbounded",
        discard: true,
      });
    }

    if (event.type === "thread.archived") {
      yield* enqueueArchiveCleanupIntent(threadId, true);
    }
  });

  const processThreadLifecycleEventSafely = (event: ThreadCleanupLifecycleEvent) =>
    processThreadLifecycleEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadLifecycleEventSafely);

  const recoverInterruptedRemovals = Effect.gen(function* () {
    const now = yield* cleanupNow();
    const jobs = yield* worktreeCleanupJobs.list();
    yield* Effect.forEach(
      jobs.filter((job) => job.status === "removing" && !queuedWorktreeCleanups.has(job.threadId)),
      (job) =>
        Effect.gen(function* () {
          const exists = yield* fileSystem.exists(job.canonicalWorktreePath);
          const registration = yield* inspectRegisteredWorktree(job);
          if (!registration.isRepo) {
            yield* worktreeCleanupJobs.markNeedsAttention({
              threadId: job.threadId,
              reason: "repository-unavailable-during-recovery",
            });
            return;
          }
          if (!exists && !registration.registered) {
            yield* checkoutCoordinator.withCheckout(job.cwd, git.pruneWorktrees(job.cwd));
            yield* worktreeCleanupJobs.markCompleted({ threadId: job.threadId });
            return;
          }
          yield* worktreeCleanupJobs.recoverRemoving({
            threadId: job.threadId,
            nextAttemptAt: now,
            reason: "recovered-after-restart",
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const nextAttemptAt = yield* cleanupRetryAt(job.attemptCount);
              yield* worktreeCleanupJobs
                .recoverRemoving({
                  threadId: job.threadId,
                  nextAttemptAt,
                  reason: "recovery-check-failed",
                })
                .pipe(
                  Effect.catchCause((recoveryCause) =>
                    Effect.logError("failed to persist worktree removal recovery", {
                      threadId: job.threadId,
                      cause: Cause.pretty(recoveryCause),
                    }),
                  ),
                );
              yield* Effect.logWarning(
                "worktree removal recovery deferred after transient failure",
                {
                  threadId: job.threadId,
                  cause: Cause.pretty(cause),
                },
              );
            }),
          ),
        ),
      { concurrency: 2, discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("failed to enumerate interrupted worktree removals", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const enqueueDueWorktreeCleanups = Effect.fn("enqueueDueWorktreeCleanups")(
    function* () {
      // Deletion events enqueue cleanup immediately; this periodic sweep is
      // recovery for missed work, so bound each pass instead of flooding the
      // shared SQLite/cleanup queues with an arbitrarily large backlog.
      const jobs = yield* worktreeCleanupJobs.listDue({
        now: yield* cleanupNow(),
        limit: CLEANUP_DUE_SWEEP_BATCH_LIMIT,
      });
      const enabled = yield* automaticCleanupEnabled;
      const runnable = enabled ? jobs : jobs.filter((job) => job.source === "delete");
      yield* Effect.forEach(runnable, (job) => enqueueWorktreeCleanup(job.threadId), {
        concurrency: 1,
        discard: true,
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("worktree cleanup due sweep failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const discoverArchivedCleanupCandidates = Effect.fn("discoverArchivedCleanupCandidates")(
    function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const candidates = readModel.threads.filter(
        (thread) => thread.archivedAt !== null && thread.deletedAt === null,
      );
      yield* Effect.forEach(candidates, (thread) => enqueueArchiveCleanupIntent(thread.id), {
        concurrency: 4,
        discard: true,
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("archived worktree cleanup discovery failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const enqueueIdleCleanupIntent = Effect.fn("enqueueIdleCleanupIntent")(function* (
    thread: OrchestrationReadModel["threads"][number],
    project: OrchestrationReadModel["projects"][number],
    readModel: OrchestrationReadModel,
    idleDays: number,
    nowMs: number,
    runtime: {
      readonly activeProviderThreadIds: ReadonlySet<ThreadId>;
      readonly runningTerminalThreadIds: ReadonlySet<ThreadId>;
    },
    options: { readonly enqueue: boolean } = { enqueue: true },
  ) {
    const previous = yield* worktreeCleanupJobs.getByThreadId(thread.id);
    const mayStartNewIntent =
      Option.isNone(previous) ||
      (previous.value.source !== "delete" &&
        (previous.value.status === "completed" || previous.value.status === "cancelled"));
    if (!mayStartNewIntent) return;

    if (
      !(yield* isIdleWorktreeEligible({
        thread,
        project,
        readModel,
        idleDays,
        nowMs,
        runtime,
        checkClean: true,
      }))
    ) {
      return;
    }
    const worktreePath = thread.worktreePath;
    if (worktreePath === null) return;
    const canonicalWorktreePath = yield* Effect.promise(() =>
      canonicalizeWorktreePath(worktreePath),
    );
    const requestedAt = yield* cleanupNow();
    const job = yield* worktreeCleanupJobs
      .enqueue({
        threadId: thread.id,
        cwd: project.workspaceRoot,
        worktreePath,
        canonicalWorktreePath,
        requestedAt,
        source: "idle",
        allowTerminalReset: Option.isSome(previous),
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logDebug("idle worktree cleanup intent not persisted", {
            threadId: thread.id,
            worktreePath: canonicalWorktreePath,
            error: error instanceof Error ? error.message : String(error),
          }).pipe(Effect.as(null)),
        ),
      );
    if (
      job === null ||
      job.status !== "waiting" ||
      (job.nextAttemptAt !== null && job.nextAttemptAt > requestedAt)
    ) {
      return;
    }
    if (!options.enqueue) return;
    yield* enqueueWorktreeCleanup(thread.id);
    yield* Effect.logInfo("queued idle worktree cleanup reconciliation", {
      threadId: thread.id,
      worktreePath: canonicalWorktreePath,
      idleDays,
      reason: "inactive-clean-worktree",
    });
  });

  const discoverIdleWorktreeCleanupCandidates = Effect.fn("discoverIdleWorktreeCleanupCandidates")(
    function* () {
      const idleDays = yield* currentIdleReclaimDays;
      if (idleDays === null || !Number.isFinite(idleDays) || idleDays < 0) return;
      const readModel = yield* orchestrationEngine.getReadModel();
      const nowMs = yield* Clock.currentTimeMillis;
      const eligiblePool = readModel.threads
        .filter((thread) => {
          if (
            thread.archivedAt !== null ||
            thread.deletedAt !== null ||
            thread.pinnedAt != null ||
            thread.worktreePath === null ||
            thread.branch === null ||
            thread.latestTurn?.state === "running" ||
            thread.session?.activeTurnId != null ||
            thread.session?.status === "starting" ||
            thread.session?.status === "running" ||
            thread.session?.status === "ready" ||
            (thread.queuedTurns?.length ?? 0) > 0
          ) {
            return false;
          }
          const lastActivity = latestThreadActivityMillis(thread);
          return lastActivity !== null && nowMs - lastActivity >= idleDays * 24 * 60 * 60 * 1000;
        })
        .sort(
          (left, right) =>
            (latestThreadActivityMillis(left) ?? 0) - (latestThreadActivityMillis(right) ?? 0),
        );
      const sweepStart = eligiblePool.length === 0 ? 0 : idleSweepOffset % eligiblePool.length;
      const oldestEligible = eligiblePool
        .slice(sweepStart)
        .concat(eligiblePool.slice(0, sweepStart))
        .slice(0, MAX_IDLE_WORKTREE_CANDIDATES_PER_SWEEP);
      // Rotate through bounded batches so a large cluster of dirty or already
      // reclaimed threads cannot starve later eligible checkouts.
      if (eligiblePool.length > 0) {
        idleSweepOffset = (sweepStart + oldestEligible.length) % eligiblePool.length;
      }
      const runtime = yield* runtimeSafetySnapshot;
      yield* Effect.forEach(
        oldestEligible,
        (thread) => {
          const project = readModel.projects.find((entry) => entry.id === thread.projectId);
          if (project === undefined || project.deletedAt !== null) return Effect.void;
          return enqueueIdleCleanupIntent(
            thread,
            project,
            readModel,
            idleDays,
            nowMs,
            runtime,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logDebug("idle worktree cleanup candidate skipped", {
                threadId: thread.id,
                worktreePath: thread.worktreePath,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        },
        { concurrency: 1, discard: true },
      );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("idle worktree cleanup discovery failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  // Associations are written when a PR is opened/linked and otherwise only
  // refreshed on archive cleanup. Without a background pass, sidebar chrome
  // keeps the original "open" colour after merge/close.
  const refreshOpenPullRequestAssociations = Effect.fn("refreshOpenPullRequestAssociations")(
    function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const groups = groupOpenPullRequestAssociationRefreshes(readModel);

      yield* Effect.forEach(
        groups,
        (group) =>
          Effect.gen(function* () {
            const resolved = yield* resolvePullRequestFromCwds(
              group.cwds,
              group.pullRequest.url,
              gitManager.resolvePullRequest,
            );
            if (resolved === null) {
              yield* Effect.logDebug("pull request association refresh skipped", {
                threadId: group.candidates[0]?.thread.id,
                pullRequestNumber: group.pullRequest.number,
                attemptedCwds: group.cwds,
              });
              return;
            }
            const nextPullRequest = resolved.pullRequest;
            yield* Effect.forEach(
              group.candidates.filter(
                ({ link: candidateLink }) =>
                  candidateLink.pullRequest.state !== nextPullRequest.state ||
                  candidateLink.pullRequest.title !== nextPullRequest.title ||
                  candidateLink.pullRequest.url !== nextPullRequest.url ||
                  candidateLink.pullRequest.baseBranch !== nextPullRequest.baseBranch ||
                  candidateLink.pullRequest.headBranch !== nextPullRequest.headBranch,
              ),
              ({ thread: candidateThread, link: candidateLink }) =>
                (threadPullRequestKey(candidateLink.pullRequest) ===
                threadPullRequestKey(nextPullRequest)
                  ? orchestrationEngine
                      .dispatch({
                        type: "thread.pull-request.link",
                        commandId: CommandId.make(crypto.randomUUID()),
                        threadId: candidateThread.id,
                        pullRequest: nextPullRequest,
                        source: candidateLink.source,
                      })
                      .pipe(
                        Effect.andThen(
                          candidateThread.pullRequest &&
                            sameThreadPullRequest(
                              candidateThread.pullRequest,
                              candidateLink.pullRequest,
                            )
                            ? orchestrationEngine.dispatch({
                                type: "thread.meta.update",
                                commandId: CommandId.make(crypto.randomUUID()),
                                threadId: candidateThread.id,
                                pullRequest: nextPullRequest,
                              })
                            : Effect.void,
                        ),
                      )
                  : orchestrationEngine.dispatch({
                      type: "thread.pull-request.rekey",
                      commandId: CommandId.make(crypto.randomUUID()),
                      threadId: candidateThread.id,
                      previousPullRequest: candidateLink.pullRequest,
                      pullRequest: nextPullRequest,
                    })
                ).pipe(
                  Effect.catch((error) =>
                    Effect.logDebug("failed to persist refreshed pull request association", {
                      threadId: candidateThread.id,
                      pullRequestNumber: candidateLink.pullRequest.number,
                      error: error instanceof Error ? error.message : String(error),
                    }),
                  ),
                ),
              { concurrency: 2, discard: true },
            );
          }),
        { concurrency: 2, discard: true },
      );
    },
  );

  /** Persist a due idle intent for a reset, ignoring the age threshold. */
  const persistManualIdleIntent = Effect.fn("persistManualIdleIntent")(function* (
    threadId: ThreadId,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    const project =
      thread === undefined
        ? undefined
        : readModel.projects.find((entry) => entry.id === thread.projectId);
    if (thread === undefined || project === undefined || project.deletedAt !== null) return null;
    yield* enqueueIdleCleanupIntent(
      thread,
      project,
      readModel,
      0,
      yield* Clock.currentTimeMillis,
      yield* runtimeSafetySnapshot,
      { enqueue: false },
    );
    const job = yield* worktreeCleanupJobs.getByThreadId(threadId);
    if (Option.isNone(job) || job.value.source !== "idle") return null;
    return { job: job.value, requestedAt: yield* cleanupNow() };
  });

  const isIdleReclaimEligibleIgnoringAge: ThreadDeletionReactorShape["isIdleReclaimEligibleIgnoringAge"] =
    (threadId) =>
      Effect.gen(function* () {
        const readModel = yield* orchestrationEngine.getReadModel();
        const thread = readModel.threads.find((entry) => entry.id === threadId);
        const project =
          thread === undefined
            ? undefined
            : readModel.projects.find((entry) => entry.id === thread.projectId);
        if (thread === undefined || project === undefined) return false;
        return yield* isIdleWorktreeEligible({
          thread,
          project,
          readModel,
          idleDays: 0,
          nowMs: yield* Clock.currentTimeMillis,
          runtime: yield* runtimeSafetySnapshot,
          checkClean: true,
        });
      }).pipe(Effect.orElseSucceed(() => false));

  const reclaimWorktreeNow: ThreadDeletionReactorShape["reclaimWorktreeNow"] = (threadId) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const archived = readModel.threads.find((entry) => entry.id === threadId)?.archivedAt != null;
      if (!archived) manualIdleReclaims.add(threadId);
      const persisted = archived
        ? yield* persistArchiveCleanupIntent(threadId, true)
        : yield* persistManualIdleIntent(threadId);
      if (persisted === null) {
        return {
          status: "skipped",
          reason: archived ? "chat has no worktree" : "not eligible for idle reclaim",
        } as const;
      }
      const { job, requestedAt } = persisted;
      if (job.status === "removing") {
        return { status: "skipped", reason: "removal already in progress" } as const;
      }
      if (job.status !== "waiting") {
        return { status: "skipped", reason: job.lastReason ?? `cleanup is ${job.status}` } as const;
      }
      if (job.nextAttemptAt !== null && job.nextAttemptAt > requestedAt) {
        // Skip retry backoff only; the cleanup worker re-checks every rule.
        yield* worktreeCleanupJobs.defer({
          threadId,
          nextAttemptAt: requestedAt,
          reason: "manual-cleanup",
        });
      }
      const done = yield* Deferred.make<void>();
      cleanupWaiters.set(threadId, [...(cleanupWaiters.get(threadId) ?? []), done]);
      yield* enqueueWorktreeCleanup(threadId);
      yield* Deferred.await(done);
      const after = yield* worktreeCleanupJobs.getByThreadId(threadId);
      if (Option.isSome(after) && after.value.status === "completed") {
        return { status: "removed" } as const;
      }
      const reason = Option.isNone(after)
        ? "cleanup job disappeared"
        : after.value.status === "cancelled"
          ? archived
            ? "chat was unarchived"
            : "chat became active or its workspace changed"
          : (after.value.lastReason ?? after.value.status);
      return { status: "skipped", reason } as const;
    }).pipe(
      Effect.ensuring(Effect.sync(() => manualIdleReclaims.delete(threadId))),
      Effect.catch(
        (error): Effect.Effect<ManualWorktreeReclaimOutcome> =>
          Effect.succeed({ status: "skipped", reason: `cleanup failed: ${error.message}` }),
      ),
    );

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* recoverInterruptedRemovals;
    yield* Effect.forkScoped(sweepWorktreeTrash);
    yield* discoverArchivedCleanupCandidates();
    yield* Effect.forkScoped(
      automaticCleanupEnabled.pipe(
        Effect.flatMap((enabled) =>
          enabled ? discoverIdleWorktreeCleanupCandidates() : Effect.void,
        ),
        Effect.ensuring(Deferred.succeed(initialIdleSweepDone, undefined)),
      ),
    );
    yield* enqueueDueWorktreeCleanups();
    yield* Effect.forkScoped(
      enqueueDueWorktreeCleanups().pipe(Effect.repeat(Schedule.spaced(CLEANUP_DUE_SWEEP_INTERVAL))),
    );
    yield* storagePolicy.runAutomatic({
      name: "archive-worktree-discovery",
      initialDelay: CLEANUP_RECONCILIATION_INTERVAL,
      interval: CLEANUP_RECONCILIATION_INTERVAL,
      sweep: () => discoverArchivedCleanupCandidates(),
    });
    yield* storagePolicy.runAutomatic({
      name: "idle-worktree-discovery",
      initialDelay: IDLE_WORKTREE_RECLAIM_INTERVAL,
      interval: IDLE_WORKTREE_RECLAIM_INTERVAL,
      sweep: () => discoverIdleWorktreeCleanupCandidates(),
    });
    yield* Effect.forkScoped(
      refreshOpenPullRequestAssociations().pipe(
        // First pass soon after boot so sidebar colours catch up without waiting
        // for archive; then keep associations warm without hammering gh.
        Effect.repeat(Schedule.spaced("5 minutes")),
      ),
    );
    yield* Effect.forkScoped(
      orchestrationEngine.getReadModel().pipe(
        Effect.flatMap((readModel) =>
          Effect.forEach(
            new Set(
              readModel.projects
                .filter((project) => project.deletedAt === null)
                .map((project) => project.workspaceRoot),
            ),
            (cwd) =>
              checkoutCoordinator.withCheckout(cwd, git.pruneWorktrees(cwd)).pipe(
                Effect.catch((error) =>
                  Effect.logDebug("worktree registration prune skipped", {
                    cwd,
                    error: error.message,
                  }),
                ),
              ),
            { concurrency: 4, discard: true },
          ),
        ),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.deleted" &&
          event.type !== "thread.archived" &&
          event.type !== "thread.unarchived"
        ) {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: Effect.gen(function* () {
      yield* Deferred.await(initialIdleSweepDone);
      yield* worker.drain;
      yield* worktreeCleanupWorker.drain;
    }),
    reclaimWorktreeNow,
    isIdleReclaimEligibleIgnoringAge,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make).pipe(
  Layer.provideMerge(WorktreeCleanupJobRepositoryLive),
  Layer.provideMerge(CheckoutCoordinatorLive),
  Layer.provideMerge(ThreadWorktreeRestorerRegistryLayer),
);
