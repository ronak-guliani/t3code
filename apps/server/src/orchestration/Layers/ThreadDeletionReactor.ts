import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Cause, Effect, FileSystem, Layer, Schedule, Stream } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { canonicalizeWorktreePath } from "../../git/worktreePaths.ts";
import { WorktreeCleanupJobRepositoryLive } from "../../persistence/Layers/WorktreeCleanupJobs.ts";
import {
  type WorktreeCleanupJob,
  WorktreeCleanupJobRepository,
} from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

export function hasActiveWorktreeOwner(
  readModel: {
    readonly threads: ReadonlyArray<{
      readonly id: ThreadId;
      readonly deletedAt: string | null;
      readonly worktreePath: string | null;
    }>;
  },
  deletedThreadId: ThreadId,
  worktreePath: string,
): boolean {
  return readModel.threads.some(
    (thread) =>
      thread.id !== deletedThreadId &&
      thread.deletedAt === null &&
      thread.worktreePath === worktreePath,
  );
}

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

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager;
  const git = yield* GitCore;
  const gitStatusBroadcaster = yield* GitStatusBroadcaster;
  const fileSystem = yield* FileSystem.FileSystem;
  const worktreeCleanupJobs = yield* WorktreeCleanupJobRepository;
  const withWorktreeLock =
    orchestrationEngine.withWorktreeLock ?? (<A, E, R>(effect: Effect.Effect<A, E, R>) => effect);

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const processWorktreeCleanup = Effect.fn("processWorktreeCleanup")(function* (
    cleanup: WorktreeCleanupJob,
  ) {
    const canonicalPath = yield* Effect.promise(() =>
      canonicalizeWorktreePath(cleanup.worktreePath),
    );
    return yield* withWorktreeLock(
      orchestrationEngine.getReadModel().pipe(
        Effect.flatMap((readModel) =>
          Effect.forEach(
            readModel.threads.flatMap((thread) =>
              thread.id !== cleanup.threadId &&
              thread.deletedAt === null &&
              thread.worktreePath !== null
                ? [thread.worktreePath]
                : [],
            ),
            (worktreePath) =>
              Effect.promise(() => canonicalizeWorktreePath(worktreePath)).pipe(
                Effect.map((activePath) => activePath === canonicalPath),
              ),
            { concurrency: 4 },
          ).pipe(
            Effect.map((matches) => matches.some(Boolean)),
            Effect.flatMap((hasActiveOwner) =>
              hasActiveOwner
                ? worktreeCleanupJobs.cancelByThreadId(cleanup.threadId).pipe(
                    Effect.tap(() =>
                      Effect.logInfo("retained shared worktree after thread deletion", {
                        threadId: cleanup.threadId,
                        worktreePath: canonicalPath,
                      }),
                    ),
                  )
                : fileSystem.exists(canonicalPath).pipe(
                    Effect.flatMap((exists) => {
                      if (!exists) {
                        return git.pruneWorktrees(cleanup.cwd).pipe(Effect.as("removed" as const));
                      }
                      return git.statusDetailsLocal(canonicalPath).pipe(
                        Effect.flatMap((status) =>
                          status.hasWorkingTreeChanges
                            ? Effect.succeed("retained-dirty" as const)
                            : git
                                .removeWorktree({
                                  cwd: cleanup.cwd,
                                  path: canonicalPath,
                                })
                                .pipe(Effect.as("removed" as const)),
                        ),
                      );
                    }),
                    Effect.tap((outcome) =>
                      outcome === "removed"
                        ? worktreeCleanupJobs.deleteByThreadId(cleanup.threadId)
                        : worktreeCleanupJobs.cancelByThreadId(cleanup.threadId),
                    ),
                    Effect.tap((outcome) =>
                      outcome === "removed"
                        ? gitStatusBroadcaster
                            .refreshStatus(cleanup.cwd)
                            .pipe(Effect.ignoreCause({ log: true }))
                        : Effect.void,
                    ),
                    Effect.tap((outcome) =>
                      outcome === "removed"
                        ? Effect.logInfo("removed orphaned worktree after thread deletion", {
                            threadId: cleanup.threadId,
                            worktreePath: canonicalPath,
                          })
                        : Effect.logWarning("retained dirty worktree after thread deletion", {
                            threadId: cleanup.threadId,
                            worktreePath: canonicalPath,
                          }),
                    ),
                  ),
            ),
          ),
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("retained worktree after thread deletion", {
            threadId: cleanup.threadId,
            worktreePath: canonicalPath,
            cause: Cause.pretty(cause),
          });
        }),
      ),
    );
  });

  const worktreeCleanupWorker = yield* makeDrainableWorker(processWorktreeCleanup);

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
    if (event.payload.worktreeCleanup !== undefined) {
      yield* worktreeCleanupWorker.enqueue({
        threadId,
        cwd: event.payload.worktreeCleanup.cwd,
        worktreePath: event.payload.worktreeCleanup.path,
        requestedAt: event.payload.deletedAt,
      });
    }
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
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

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const enqueuePendingWorktreeCleanups = worktreeCleanupJobs.list().pipe(
    Effect.flatMap((jobs) =>
      Effect.forEach(jobs, worktreeCleanupWorker.enqueue, {
        concurrency: 1,
        discard: true,
      }),
    ),
    Effect.catch((error) =>
      Effect.logWarning("failed to restore pending worktree cleanup jobs", {
        error: error.message,
      }),
    ),
  );

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      enqueuePendingWorktreeCleanups.pipe(Effect.repeat(Schedule.spaced("60 seconds"))),
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
              git.pruneWorktrees(cwd).pipe(
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
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain.pipe(Effect.andThen(worktreeCleanupWorker.drain)),
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make).pipe(
  Layer.provideMerge(WorktreeCleanupJobRepositoryLive),
);
