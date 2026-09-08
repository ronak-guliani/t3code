import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";
import { IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const WorktreeCleanupSource = Schema.Literals(["archive", "delete", "legacy"]);
export type WorktreeCleanupSource = typeof WorktreeCleanupSource.Type;

export const WorktreeCleanupStatus = Schema.Literals([
  "waiting",
  "removing",
  "needs-attention",
  "completed",
  "cancelled",
]);
export type WorktreeCleanupStatus = typeof WorktreeCleanupStatus.Type;

export const WorktreeCleanupJob = Schema.Struct({
  threadId: ThreadId,
  cwd: Schema.String,
  worktreePath: Schema.String,
  canonicalWorktreePath: Schema.String,
  requestedAt: IsoDateTime,
  source: WorktreeCleanupSource,
  status: WorktreeCleanupStatus,
  attemptCount: NonNegativeInt,
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  lastReason: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});
export type WorktreeCleanupJob = typeof WorktreeCleanupJob.Type;

export const WorktreeCleanupIntent = Schema.Struct({
  threadId: ThreadId,
  cwd: Schema.String,
  worktreePath: Schema.String,
  canonicalWorktreePath: Schema.String,
  requestedAt: IsoDateTime,
  source: Schema.Literals(["archive", "delete"]),
  allowTerminalReset: Schema.Boolean,
});
export type WorktreeCleanupIntent = typeof WorktreeCleanupIntent.Type;

export const WorktreeCleanupReservation = Schema.Struct({
  threadId: ThreadId,
  canonicalWorktreePath: Schema.String,
  reservedAt: IsoDateTime,
});
export type WorktreeCleanupReservation = typeof WorktreeCleanupReservation.Type;

export const WorktreeCleanupFailureResult = Schema.Struct({
  attemptCount: NonNegativeInt,
  status: WorktreeCleanupStatus,
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  lastReason: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});
export type WorktreeCleanupFailureResult = typeof WorktreeCleanupFailureResult.Type;

export interface WorktreeCleanupJobRepositoryShape {
  readonly enqueue: (
    intent: WorktreeCleanupIntent,
  ) => Effect.Effect<WorktreeCleanupJob, ProjectionRepositoryError>;
  readonly list: () => Effect.Effect<ReadonlyArray<WorktreeCleanupJob>, ProjectionRepositoryError>;
  readonly listDue: (input: {
    readonly now: IsoDateTime;
  }) => Effect.Effect<ReadonlyArray<WorktreeCleanupJob>, ProjectionRepositoryError>;
  readonly getByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<WorktreeCleanupJob>, ProjectionRepositoryError>;
  readonly hasReservationByPath: (
    canonicalWorktreePath: string,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly tryReserveForRemoval: (input: {
    readonly threadId: ThreadId;
    readonly canonicalWorktreePath: string;
    readonly reservedAt: IsoDateTime;
  }) => Effect.Effect<
    Option.Option<{
      readonly cleanup: WorktreeCleanupJob;
      readonly reservation: WorktreeCleanupReservation;
    }>,
    ProjectionRepositoryError
  >;
  readonly markNeedsAttention: (input: {
    readonly threadId: ThreadId;
    readonly reason: string;
    readonly error?: string | undefined;
  }) => Effect.Effect<Option.Option<WorktreeCleanupJob>, ProjectionRepositoryError>;
  readonly retry: (input: {
    readonly threadId: ThreadId;
    readonly nextAttemptAt: IsoDateTime;
  }) => Effect.Effect<Option.Option<WorktreeCleanupJob>, ProjectionRepositoryError>;
  readonly defer: (input: {
    readonly threadId: ThreadId;
    readonly nextAttemptAt: IsoDateTime;
    readonly reason: string;
    readonly error?: string | undefined;
  }) => Effect.Effect<Option.Option<WorktreeCleanupJob>, ProjectionRepositoryError>;
  readonly recoverRemoving: (input: {
    readonly threadId: ThreadId;
    readonly nextAttemptAt: IsoDateTime;
    readonly reason: string;
  }) => Effect.Effect<Option.Option<WorktreeCleanupJob>, ProjectionRepositoryError>;
  readonly markCompleted: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<Option.Option<WorktreeCleanupJob>, ProjectionRepositoryError>;
  readonly markCompletedWithoutRemoval: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<Option.Option<WorktreeCleanupJob>, ProjectionRepositoryError>;
  readonly cancelByThreadId: (threadId: ThreadId) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly recordFailure: (input: {
    readonly threadId: ThreadId;
    readonly error: string;
    readonly reason?: string | undefined;
    readonly nextAttemptAt?: IsoDateTime | null | undefined;
    readonly now?: IsoDateTime | undefined;
    readonly maxAttempts: number;
  }) => Effect.Effect<Option.Option<WorktreeCleanupFailureResult>, ProjectionRepositoryError>;
}

export class WorktreeCleanupJobRepository extends Context.Service<
  WorktreeCleanupJobRepository,
  WorktreeCleanupJobRepositoryShape
>()("t3/persistence/Services/WorktreeCleanupJobs/WorktreeCleanupJobRepository") {}
