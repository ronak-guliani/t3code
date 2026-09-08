import { Clock, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  WorktreeCleanupFailureResult,
  WorktreeCleanupIntent,
  WorktreeCleanupJob,
  WorktreeCleanupJobInput,
  WorktreeCleanupJobRepository,
  WorktreeCleanupReservation,
  type WorktreeCleanupJobRepositoryShape,
} from "../Services/WorktreeCleanupJobs.ts";

const ThreadRequest = Schema.Struct({ threadId: WorktreeCleanupJob.fields.threadId });
const DueJobsRequest = Schema.Struct({ now: WorktreeCleanupJob.fields.requestedAt });
const ReservationByPathRequest = Schema.Struct({
  canonicalWorktreePath: Schema.String,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getJobRow = SqlSchema.findOneOption({
    Request: ThreadRequest,
    Result: WorktreeCleanupJob,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          cwd,
          worktree_path AS "worktreePath",
          canonical_worktree_path AS "canonicalWorktreePath",
          requested_at AS "requestedAt",
          source,
          status,
          attempt_count AS "attemptCount",
          next_attempt_at AS "nextAttemptAt",
          last_reason AS "lastReason",
          last_error AS "lastError"
        FROM worktree_cleanup_jobs
        WHERE thread_id = ${threadId}
      `,
  });

  const getReservationByPath = SqlSchema.findOneOption({
    Request: ReservationByPathRequest,
    Result: WorktreeCleanupReservation,
    execute: ({ canonicalWorktreePath }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          canonical_worktree_path AS "canonicalWorktreePath",
          reserved_at AS "reservedAt"
        FROM worktree_cleanup_reservations
        WHERE canonical_worktree_path = ${canonicalWorktreePath}
      `,
  });

  const upsertLegacyJob = SqlSchema.void({
    Request: WorktreeCleanupJobInput,
    execute: (job) =>
      sql`
        INSERT INTO worktree_cleanup_jobs (
          thread_id,
          cwd,
          worktree_path,
          canonical_worktree_path,
          requested_at,
          source,
          status,
          attempt_count,
          next_attempt_at,
          last_reason,
          last_error
        )
        VALUES (
          ${job.threadId},
          ${job.cwd},
          ${job.worktreePath},
          ${job.worktreePath},
          ${job.requestedAt},
          'legacy',
          'needs-attention',
          0,
          NULL,
          COALESCE(${job.reason ?? null}, 'legacy-cleanup-intent-requires-review'),
          NULL
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          cwd = excluded.cwd,
          worktree_path = excluded.worktree_path,
          canonical_worktree_path = excluded.canonical_worktree_path,
          requested_at = excluded.requested_at,
          last_reason = COALESCE(excluded.last_reason, worktree_cleanup_jobs.last_reason)
        WHERE worktree_cleanup_jobs.status NOT IN ('cancelled', 'completed')
      `,
  });

  const enqueueJob = SqlSchema.void({
    Request: WorktreeCleanupIntent,
    execute: (intent) =>
      sql`
        INSERT INTO worktree_cleanup_jobs (
          thread_id,
          cwd,
          worktree_path,
          canonical_worktree_path,
          requested_at,
          source,
          status,
          attempt_count,
          next_attempt_at,
          last_reason,
          last_error
        )
        VALUES (
          ${intent.threadId},
          ${intent.cwd},
          ${intent.worktreePath},
          ${intent.canonicalWorktreePath},
          ${intent.requestedAt},
          ${intent.source},
          'waiting',
          0,
          ${intent.requestedAt},
          NULL,
          NULL
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          cwd = excluded.cwd,
          worktree_path = excluded.worktree_path,
          canonical_worktree_path = excluded.canonical_worktree_path,
          requested_at = excluded.requested_at,
          source = excluded.source
        WHERE worktree_cleanup_jobs.status NOT IN ('cancelled', 'completed')
      `,
  });

  const listJobs = SqlSchema.findAll({
    Request: Schema.Void,
    Result: WorktreeCleanupJob,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          cwd,
          worktree_path AS "worktreePath",
          canonical_worktree_path AS "canonicalWorktreePath",
          requested_at AS "requestedAt",
          source,
          status,
          attempt_count AS "attemptCount",
          next_attempt_at AS "nextAttemptAt",
          last_reason AS "lastReason",
          last_error AS "lastError"
        FROM worktree_cleanup_jobs
        ORDER BY requested_at ASC, thread_id ASC
      `,
  });

  const listDueJobs = SqlSchema.findAll({
    Request: DueJobsRequest,
    Result: WorktreeCleanupJob,
    execute: ({ now }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          cwd,
          worktree_path AS "worktreePath",
          canonical_worktree_path AS "canonicalWorktreePath",
          requested_at AS "requestedAt",
          source,
          status,
          attempt_count AS "attemptCount",
          next_attempt_at AS "nextAttemptAt",
          last_reason AS "lastReason",
          last_error AS "lastError"
        FROM worktree_cleanup_jobs
        WHERE status = 'waiting'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
        ORDER BY next_attempt_at ASC, requested_at ASC, thread_id ASC
      `,
  });

  const getPendingJob = SqlSchema.findOneOption({
    Request: ThreadRequest,
    Result: WorktreeCleanupJob,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          cwd,
          worktree_path AS "worktreePath",
          canonical_worktree_path AS "canonicalWorktreePath",
          requested_at AS "requestedAt",
          source,
          status,
          attempt_count AS "attemptCount",
          next_attempt_at AS "nextAttemptAt",
          last_reason AS "lastReason",
          last_error AS "lastError"
        FROM worktree_cleanup_jobs
        WHERE thread_id = ${threadId}
          AND status IN ('waiting', 'removing')
      `,
  });

  const pathHasReservation = SqlSchema.findOne({
    Request: ReservationByPathRequest,
    Result: Schema.Struct({ found: Schema.Number }),
    execute: ({ canonicalWorktreePath }) =>
      sql`
        SELECT EXISTS(
          SELECT 1
          FROM worktree_cleanup_reservations
          WHERE canonical_worktree_path = ${canonicalWorktreePath}
        ) AS found
      `,
  });

  const tryReserveForRemoval = (input: {
    readonly threadId: WorktreeCleanupJob["threadId"];
    readonly canonicalWorktreePath: string;
    readonly reservedAt: WorktreeCleanupJob["requestedAt"];
  }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const eligibleJob = yield* getJobRow({ threadId: input.threadId });
        if (
          Option.isNone(eligibleJob) ||
          eligibleJob.value.status !== "waiting" ||
          eligibleJob.value.canonicalWorktreePath !== input.canonicalWorktreePath ||
          (eligibleJob.value.nextAttemptAt !== null &&
            eligibleJob.value.nextAttemptAt > input.reservedAt)
        ) {
          return Option.none<{
            readonly cleanup: WorktreeCleanupJob;
            readonly reservation: WorktreeCleanupReservation;
          }>();
        }

        yield* sql`
          INSERT INTO worktree_cleanup_reservations (
            canonical_worktree_path,
            thread_id,
            reserved_at
          )
          VALUES (
            ${input.canonicalWorktreePath},
            ${input.threadId},
            ${input.reservedAt}
          )
          ON CONFLICT DO NOTHING
        `;

        const reservation = yield* getReservationByPath({
          canonicalWorktreePath: input.canonicalWorktreePath,
        });
        if (Option.isNone(reservation) || reservation.value.threadId !== input.threadId) {
          return Option.none<{
            readonly cleanup: WorktreeCleanupJob;
            readonly reservation: WorktreeCleanupReservation;
          }>();
        }

        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET status = 'removing'
          WHERE thread_id = ${input.threadId}
            AND status = 'waiting'
        `;

        return Option.some({
          cleanup: { ...eligibleJob.value, status: "removing" as const },
          reservation: reservation.value,
        });
      }),
    );

  const markJobNeedsAttention = (input: {
    readonly threadId: WorktreeCleanupJob["threadId"];
    readonly reason: string;
    readonly error?: string | undefined;
  }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getJobRow({ threadId: input.threadId });
        if (
          Option.isNone(current) ||
          current.value.status === "cancelled" ||
          current.value.status === "completed"
        ) {
          return Option.none<WorktreeCleanupJob>();
        }

        yield* sql`
          DELETE FROM worktree_cleanup_reservations
          WHERE thread_id = ${input.threadId}
        `;
        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'needs-attention',
            next_attempt_at = NULL,
            last_reason = ${input.reason},
            last_error = ${input.error ?? null}
          WHERE thread_id = ${input.threadId}
        `;
        return yield* getJobRow({ threadId: input.threadId });
      }),
    );

  const markJobCompleted = (threadId: WorktreeCleanupJob["threadId"]) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getJobRow({ threadId });
        if (Option.isNone(current) || current.value.status !== "removing") {
          return Option.none<WorktreeCleanupJob>();
        }

        yield* sql`
          DELETE FROM worktree_cleanup_reservations
          WHERE thread_id = ${threadId}
        `;
        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'completed',
            next_attempt_at = NULL
          WHERE thread_id = ${threadId}
        `;
        return yield* getJobRow({ threadId });
      }),
    );

  const markJobCompletedWithoutRemoval = (threadId: WorktreeCleanupJob["threadId"]) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getJobRow({ threadId });
        if (Option.isNone(current) || current.value.status !== "waiting") {
          return Option.none<WorktreeCleanupJob>();
        }

        yield* sql`
          DELETE FROM worktree_cleanup_reservations
          WHERE thread_id = ${threadId}
        `;
        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'completed',
            next_attempt_at = NULL,
            last_reason = 'worktree-already-absent'
          WHERE thread_id = ${threadId}
            AND status = 'waiting'
        `;
        return yield* getJobRow({ threadId });
      }),
    );

  const deferJob = (input: {
    readonly threadId: WorktreeCleanupJob["threadId"];
    readonly nextAttemptAt: WorktreeCleanupJob["nextAttemptAt"];
    readonly reason: string;
    readonly error?: string | undefined;
  }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getJobRow({ threadId: input.threadId });
        if (
          Option.isNone(current) ||
          current.value.status === "cancelled" ||
          current.value.status === "completed" ||
          current.value.status === "needs-attention"
        ) {
          return Option.none<WorktreeCleanupJob>();
        }

        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'waiting',
            next_attempt_at = ${input.nextAttemptAt},
            last_reason = ${input.reason},
            last_error = ${input.error ?? null}
          WHERE thread_id = ${input.threadId}
            AND status IN ('waiting', 'removing')
        `;
        yield* sql`
          DELETE FROM worktree_cleanup_reservations
          WHERE thread_id = ${input.threadId}
        `;
        return yield* getJobRow({ threadId: input.threadId });
      }),
    );

  const retryJob = (input: {
    readonly threadId: WorktreeCleanupJob["threadId"];
    readonly nextAttemptAt: WorktreeCleanupJob["nextAttemptAt"];
  }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getJobRow({ threadId: input.threadId });
        if (Option.isNone(current) || current.value.status !== "needs-attention") {
          return Option.none<WorktreeCleanupJob>();
        }
        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'waiting',
            next_attempt_at = ${input.nextAttemptAt},
            last_reason = 'manual-retry',
            last_error = NULL
          WHERE thread_id = ${input.threadId}
            AND status = 'needs-attention'
        `;
        return yield* getJobRow({ threadId: input.threadId });
      }),
    );

  const recoverRemovingJob = (input: {
    readonly threadId: WorktreeCleanupJob["threadId"];
    readonly nextAttemptAt: WorktreeCleanupJob["nextAttemptAt"];
    readonly reason: string;
  }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getJobRow({ threadId: input.threadId });
        if (Option.isNone(current) || current.value.status !== "removing") {
          return Option.none<WorktreeCleanupJob>();
        }

        yield* sql`
          DELETE FROM worktree_cleanup_reservations
          WHERE thread_id = ${input.threadId}
        `;
        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'waiting',
            next_attempt_at = ${input.nextAttemptAt},
            last_reason = ${input.reason},
            last_error = NULL
          WHERE thread_id = ${input.threadId}
            AND status = 'removing'
        `;
        return yield* getJobRow({ threadId: input.threadId });
      }),
    );

  const cancelJob = (threadId: WorktreeCleanupJob["threadId"]) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM worktree_cleanup_reservations
          WHERE thread_id = ${threadId}
            AND EXISTS (
              SELECT 1
              FROM worktree_cleanup_jobs
              WHERE thread_id = ${threadId}
                AND status IN ('waiting', 'needs-attention')
            )
        `;
        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'cancelled',
            next_attempt_at = NULL,
            last_reason = COALESCE(last_reason, 'explicitly-cancelled')
          WHERE thread_id = ${threadId}
            AND status IN ('waiting', 'needs-attention')
        `;
      }),
    );

  const deleteJob = (threadId: WorktreeCleanupJob["threadId"]) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM worktree_cleanup_reservations
          WHERE thread_id = ${threadId}
        `;
        yield* sql`
          DELETE FROM worktree_cleanup_jobs
          WHERE thread_id = ${threadId}
        `;
      }),
    );

  const recordJobFailure = (input: {
    readonly threadId: WorktreeCleanupJob["threadId"];
    readonly error: string;
    readonly reason?: string | undefined;
    readonly nextAttemptAt?: WorktreeCleanupJob["nextAttemptAt"] | undefined;
    readonly now?: WorktreeCleanupJob["requestedAt"] | undefined;
    readonly maxAttempts: number;
  }) =>
    Effect.gen(function* () {
      const now = input.now ?? new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* getJobRow({ threadId: input.threadId });
          if (
            Option.isNone(current) ||
            current.value.status === "cancelled" ||
            current.value.status === "completed" ||
            current.value.status === "needs-attention"
          ) {
            return Option.none<typeof WorktreeCleanupFailureResult.Type>();
          }

          const attemptCount = current.value.attemptCount + 1;
          const exhausted = attemptCount >= input.maxAttempts;
          yield* sql`
            DELETE FROM worktree_cleanup_reservations
            WHERE thread_id = ${input.threadId}
          `;
          yield* sql`
            UPDATE worktree_cleanup_jobs
            SET
              attempt_count = ${attemptCount},
              status = ${exhausted ? "needs-attention" : "waiting"},
              next_attempt_at = ${exhausted ? null : (input.nextAttemptAt ?? now)},
              last_reason = ${input.reason ?? "removal-failed"},
              last_error = ${input.error}
            WHERE thread_id = ${input.threadId}
          `;

          const updated = yield* getJobRow({ threadId: input.threadId });
          return Option.map(updated, (job) => ({
            attemptCount: job.attemptCount,
            status: job.status,
            nextAttemptAt: job.nextAttemptAt,
            lastReason: job.lastReason,
            lastError: job.lastError,
          }));
        }),
      );
    });

  return {
    upsert: (job) =>
      upsertLegacyJob(job).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.upsert:query")),
      ),
    enqueue: (intent) =>
      enqueueJob(intent).pipe(
        Effect.flatMap(() => getJobRow({ threadId: intent.threadId })),
        Effect.flatMap((job) =>
          Option.isSome(job)
            ? Effect.succeed(job.value)
            : Effect.die(
                new Error(
                  `Worktree cleanup intent disappeared while enqueueing ${intent.threadId}`,
                ),
              ),
        ),
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.enqueue:query")),
      ),
    list: () =>
      listJobs(undefined).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.list:query")),
      ),
    listDue: (input) =>
      listDueJobs(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.listDue:query")),
      ),
    getByThreadId: (threadId) =>
      getJobRow({ threadId }).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.getByThreadId:query")),
      ),
    getPendingByThreadId: (threadId) =>
      getPendingJob({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.getPendingByThreadId:query"),
        ),
      ),
    existsByPath: (worktreePath) =>
      pathHasReservation({ canonicalWorktreePath: worktreePath }).pipe(
        Effect.map((row) => row.found === 1),
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.existsByPath:query")),
      ),
    hasReservationByPath: (canonicalWorktreePath) =>
      pathHasReservation({ canonicalWorktreePath }).pipe(
        Effect.map((row) => row.found === 1),
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.hasReservationByPath:query"),
        ),
      ),
    tryReserveForRemoval: (input) =>
      tryReserveForRemoval(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.tryReserveForRemoval:query"),
        ),
      ),
    markNeedsAttention: (input) =>
      markJobNeedsAttention(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.markNeedsAttention:query"),
        ),
      ),
    defer: (input) =>
      deferJob(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.defer:query")),
      ),
    retry: (input) =>
      retryJob(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.retry:query")),
      ),
    recoverRemoving: (input) =>
      recoverRemovingJob(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.recoverRemoving:query"),
        ),
      ),
    markCompleted: (input) =>
      markJobCompleted(input.threadId).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.markCompleted:query")),
      ),
    markCompletedWithoutRemoval: (input) =>
      markJobCompletedWithoutRemoval(input.threadId).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.markCompletedWithoutRemoval:query"),
        ),
      ),
    cancelByThreadId: (threadId) =>
      cancelJob(threadId).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.cancelByThreadId:query"),
        ),
      ),
    recordFailure: (input) =>
      recordJobFailure(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.recordFailure:query")),
      ),
    deleteByThreadId: (threadId) =>
      deleteJob(threadId).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.deleteByThreadId:query"),
        ),
      ),
  } satisfies WorktreeCleanupJobRepositoryShape;
});

export const WorktreeCleanupJobRepositoryLive = Layer.effect(WorktreeCleanupJobRepository, make);
