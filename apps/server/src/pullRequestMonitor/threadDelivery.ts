/**
 * Orchestration boundaries the PR monitor uses to reach threads.
 *
 * Delivery always goes through the durable queued-turn command so remediation never
 * steers an active turn; QueuedTurnReactor dispatches it once the thread is idle.
 * Fallback creates the thread first and starts its turn only after the caller has
 * claimed exclusive ownership.
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  QueuedTurnId,
  type ModelSelection,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as crypto from "node:crypto";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";

export type OwnerAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: "owner-missing" | "owner-unavailable" }
  | { readonly kind: "unknown"; readonly cause: unknown };

/**
 * Whether a thread still has work in flight. A queued turn counts: the thread is
 * scheduled to act, so taking ownership away from it would create a second modifier.
 */
export function threadShellIsBusy(shell: {
  readonly latestTurn: { readonly state: string } | null;
  readonly session: { readonly status: string; readonly activeTurnId: string | null } | null;
  readonly hasPendingQueuedTurn?: boolean;
}): boolean {
  if (shell.latestTurn?.state === "running") return true;
  if (shell.session?.status === "running" && shell.session.activeTurnId !== null) return true;
  return shell.hasPendingQueuedTurn === true;
}

export type ThreadActivity =
  | { readonly kind: "missing" }
  | { readonly kind: "busy" }
  | { readonly kind: "idle" }
  | { readonly kind: "unknown"; readonly cause: unknown };

/** Read-only activity probe used before any ownership takeover. */
export const resolveThreadActivity = (
  threadId: ThreadId,
): Effect.Effect<ThreadActivity, never, ProjectionSnapshotQuery> =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    const result = yield* Effect.result(projections.getThreadShellById(threadId));
    if (Result.isFailure(result)) {
      return isMissingThreadFailure(result.failure)
        ? ({ kind: "missing" } as const)
        : ({ kind: "unknown", cause: result.failure } as const);
    }
    if (Option.isNone(result.success)) return { kind: "missing" } as const;
    return threadShellIsBusy(result.success.value)
      ? ({ kind: "busy" } as const)
      : ({ kind: "idle" } as const);
  });

/** Interrupt a thread that must stop modifying a worktree before ownership moves. */
export const interruptThreadTurn = (input: {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
}): Effect.Effect<void, never, OrchestrationEngineService> =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const now = yield* Effect.map(DateTime.now, (d) => DateTime.formatIso(DateTime.toUtc(d)));
    yield* engine
      .dispatch({
        type: "thread.turn.interrupt",
        commandId: input.commandId,
        threadId: input.threadId,
        createdAt: now,
      })
      .pipe(Effect.ignore);
  });

export function isMissingThreadFailure(failure: unknown): boolean {
  let current: unknown = failure;
  for (let depth = 0; depth < 6 && current != null; depth++) {
    if (
      typeof current === "object" &&
      current !== null &&
      "_tag" in current &&
      (current._tag === "ProjectionStoreThreadNotFoundError" ||
        current._tag === "ThreadNotFoundError" ||
        current._tag === "OrchestrationThreadNotFoundError")
    ) {
      return true;
    }
    if (typeof current === "object" && current !== null && "cause" in current) {
      current = (current as { cause: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}

export const resolveOwnerAvailability = (
  ownerThreadId: ThreadId | null,
): Effect.Effect<OwnerAvailability, never, ProjectionSnapshotQuery> =>
  Effect.gen(function* () {
    if (ownerThreadId === null) {
      return { kind: "unavailable" as const, reason: "owner-missing" as const };
    }
    const projections = yield* ProjectionSnapshotQuery;
    const result = yield* Effect.result(projections.getThreadShellById(ownerThreadId));
    if (Result.isFailure(result)) {
      if (isMissingThreadFailure(result.failure)) {
        return { kind: "unavailable" as const, reason: "owner-unavailable" as const };
      }
      return { kind: "unknown" as const, cause: result.failure };
    }
    const shell = result.success;
    if (Option.isNone(shell)) {
      return { kind: "unavailable" as const, reason: "owner-unavailable" as const };
    }
    const thread = shell.value;
    if (thread.archivedAt !== null) {
      return { kind: "unavailable" as const, reason: "owner-unavailable" as const };
    }
    return { kind: "available" as const };
  });

export const requireProjectThread = (input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}): Effect.Effect<
  {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  },
  unknown,
  ProjectionSnapshotQuery
> =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    const shellOpt = yield* projections.getThreadShellById(input.threadId);
    if (Option.isNone(shellOpt)) {
      return yield* Effect.fail(new Error("Thread not found"));
    }
    const thread = shellOpt.value;
    if (thread.projectId !== input.projectId) {
      return yield* Effect.fail(new Error("Thread is outside this monitor project"));
    }
    if (thread.archivedAt !== null) {
      return yield* Effect.fail(new Error("Thread is archived or deleted"));
    }
    return {
      threadId: thread.id,
      projectId: thread.projectId,
      worktreePath: thread.worktreePath,
    };
  });

/**
 * Durably queue remediation behind any active turn. QueuedTurnReactor dispatches
 * when the thread is free; never call thread.turn.start for feedback delivery.
 */
export const sendQueuedTurn = (input: {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
}): Effect.Effect<void, unknown, OrchestrationEngineService> =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const now = yield* Effect.map(DateTime.now, (d) => DateTime.formatIso(DateTime.toUtc(d)));
    // Deterministic queued-turn id from delivery command id for logical exactly-once.
    const queuedTurnId = QueuedTurnId.make(`prm-q:${input.commandId}`);
    yield* engine.dispatch({
      type: "thread.queued-turn.create",
      commandId: input.commandId,
      threadId: input.threadId,
      queuedTurnId,
      message: {
        messageId: input.messageId,
        role: "user",
        text: input.text,
        attachments: [],
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      origin: {
        kind: "pull-request-monitor",
        repository: input.repository,
        number: input.pullRequestNumber,
      },
      createdAt: now,
    });
  });

/**
 * Create the fallback thread with a prepared worktree. Does not start a turn —
 * callers claim ownership first, then call startFallbackTurn.
 */
export const createFallbackThread = (input: {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly pullRequest: {
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly baseBranch: string;
    readonly headBranch: string;
  };
}): Effect.Effect<{ readonly threadId: ThreadId }, unknown, OrchestrationEngineService> =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const now = yield* Effect.map(DateTime.now, (d) => DateTime.formatIso(DateTime.toUtc(d)));
    const threadId = ThreadId.make(crypto.randomUUID());
    yield* engine.dispatch({
      type: "thread.create",
      commandId: input.commandId,
      threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: input.branch,
      worktreePath: input.worktreePath,
      pullRequest: {
        number: input.pullRequest.number,
        title: input.pullRequest.title,
        url: input.pullRequest.url,
        baseBranch: input.pullRequest.baseBranch,
        headBranch: input.pullRequest.headBranch,
        state: "open",
      },
      createdAt: now,
    });
    return { threadId };
  });

/** Start the first maintenance turn after ownership has been claimed. */
export const startFallbackTurn = (input: {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
}): Effect.Effect<void, unknown, OrchestrationEngineService> =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const now = yield* Effect.map(DateTime.now, (d) => DateTime.formatIso(DateTime.toUtc(d)));
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: input.commandId,
      threadId: input.threadId,
      message: {
        messageId: input.messageId,
        role: "user",
        text: input.text,
        attachments: [],
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      origin: {
        kind: "pull-request-monitor",
        repository: input.repository,
        number: input.pullRequestNumber,
      },
      createdAt: now,
    });
  });

export const waitForThreadWorktree = (
  threadId: ThreadId,
): Effect.Effect<boolean, never, ProjectionSnapshotQuery> =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = yield* Effect.result(projections.getThreadShellById(threadId));
      if (Result.isFailure(result)) {
        if (isMissingThreadFailure(result.failure) && attempt > 2) return false;
        yield* Effect.sleep("500 millis");
        continue;
      }
      if (Option.isNone(result.success)) {
        yield* Effect.sleep("500 millis");
        continue;
      }
      const path = result.success.value.worktreePath;
      if (typeof path === "string" && path.length > 0) return true;
      yield* Effect.sleep("500 millis");
    }
    return false;
  });

export const abandonFallbackThread = (input: {
  readonly threadId: ThreadId;
  readonly commandIdPrefix: string;
}): Effect.Effect<void, never, OrchestrationEngineService> =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const now = yield* Effect.map(DateTime.now, (d) => DateTime.formatIso(DateTime.toUtc(d)));
    yield* engine
      .dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(`${input.commandIdPrefix}:interrupt`),
        threadId: input.threadId,
        createdAt: now,
      })
      .pipe(Effect.ignore);
    yield* engine
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`${input.commandIdPrefix}:archive`),
        threadId: input.threadId,
      })
      .pipe(Effect.ignore);
  });
