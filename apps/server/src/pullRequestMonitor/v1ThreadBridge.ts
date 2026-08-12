/**
 * V1 orchestration adapters for PR monitoring (main has no orchestration-v2).
 * Delivery uses thread.turn.start (queued when a turn is active). Fallback uses
 * bootstrap createThread with a prepared worktree path.
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
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

export const sendQueuedTurn = (input: {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly text: string;
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
      createdAt: now,
    });
  });

export const launchFallbackThread = (input: {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
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
  readonly prompt: string;
}): Effect.Effect<{ readonly threadId: ThreadId }, unknown, OrchestrationEngineService> =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const now = yield* Effect.map(DateTime.now, (d) => DateTime.formatIso(DateTime.toUtc(d)));
    const threadId = ThreadId.make(crypto.randomUUID());
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: input.commandId,
      threadId,
      message: {
        messageId: input.messageId,
        role: "user",
        text: input.prompt,
        attachments: [],
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: now,
      bootstrap: {
        createThread: {
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
        },
      },
    } as never);
    return { threadId };
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
