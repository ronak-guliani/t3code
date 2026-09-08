import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { WorktreeCleanupJobRepositoryLive } from "./WorktreeCleanupJobs.ts";
import { WorktreeCleanupJobRepository } from "../Services/WorktreeCleanupJobs.ts";

const testLayer = it.layer(
  Layer.mergeAll(
    WorktreeCleanupJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const at = (seconds: number) =>
  `1970-01-01T00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}.000Z`;

const intent = (input: {
  readonly id: string;
  readonly path: string;
  readonly source?: "archive" | "delete";
  readonly requestedAt?: string;
}) => ({
  threadId: ThreadId.make(input.id),
  cwd: "/tmp/project",
  worktreePath: input.path,
  canonicalWorktreePath: input.path,
  requestedAt: input.requestedAt ?? at(0),
  source: input.source ?? "archive",
});

testLayer("WorktreeCleanupJobRepository", (it) => {
  it.effect("keeps intents separate from canonical-path removal reservations", () =>
    Effect.gen(function* () {
      const jobs = yield* WorktreeCleanupJobRepository;
      const first = yield* jobs.enqueue(intent({ id: "cleanup-first", path: "/tmp/shared" }));
      const second = yield* jobs.enqueue(
        intent({ id: "cleanup-second", path: "/tmp/shared", source: "delete" }),
      );

      assert.equal(first.status, "waiting");
      assert.equal(second.status, "waiting");
      assert.isFalse(yield* jobs.hasReservationByPath("/tmp/shared"));
      assert.deepEqual(
        (yield* jobs.listDue({ now: at(0) })).map((job) => job.threadId),
        [first.threadId, second.threadId],
      );

      const reservation = yield* jobs.tryReserveForRemoval({
        threadId: first.threadId,
        canonicalWorktreePath: "/tmp/shared",
        reservedAt: at(0),
      });
      assert.isTrue(Option.isSome(reservation));
      assert.isTrue(yield* jobs.hasReservationByPath("/tmp/shared"));
      assert.equal(
        (yield* jobs.getByThreadId(first.threadId)).pipe(Option.getOrThrow).status,
        "removing",
      );
      assert.isTrue(
        Option.isNone(
          yield* jobs.tryReserveForRemoval({
            threadId: second.threadId,
            canonicalWorktreePath: "/tmp/shared",
            reservedAt: at(0),
          }),
        ),
      );

      const needsAttention = yield* jobs.markNeedsAttention({
        threadId: first.threadId,
        reason: "dirty-worktree",
      });
      assert.equal(needsAttention.pipe(Option.getOrThrow).status, "needs-attention");
      assert.isFalse(yield* jobs.hasReservationByPath("/tmp/shared"));

      const secondReservation = yield* jobs.tryReserveForRemoval({
        threadId: second.threadId,
        canonicalWorktreePath: "/tmp/shared",
        reservedAt: at(0),
      });
      assert.isTrue(Option.isSome(secondReservation));
      const completed = yield* jobs.markCompleted({ threadId: second.threadId });
      assert.equal(completed.pipe(Option.getOrThrow).status, "completed");
      assert.isFalse(yield* jobs.hasReservationByPath("/tmp/shared"));
    }),
  );

  it.effect(
    "persists backoff and escalates repeated failures without retaining a reservation",
    () =>
      Effect.gen(function* () {
        const jobs = yield* WorktreeCleanupJobRepository;
        const cleanup = yield* jobs.enqueue(
          intent({ id: "cleanup-retry", path: "/tmp/retry", requestedAt: at(0) }),
        );

        yield* jobs.tryReserveForRemoval({
          threadId: cleanup.threadId,
          canonicalWorktreePath: "/tmp/retry",
          reservedAt: at(0),
        });
        const firstFailure = yield* jobs.recordFailure({
          threadId: cleanup.threadId,
          error: "git unavailable",
          reason: "git-command-failed",
          now: at(1),
          nextAttemptAt: at(10),
          maxAttempts: 2,
        });
        assert.deepEqual(
          firstFailure,
          Option.some({
            attemptCount: 1,
            status: "waiting",
            nextAttemptAt: at(10),
            lastReason: "git-command-failed",
            lastError: "git unavailable",
          }),
        );
        assert.isFalse(yield* jobs.hasReservationByPath("/tmp/retry"));
        assert.deepEqual(yield* jobs.listDue({ now: at(9) }), []);
        assert.equal((yield* jobs.listDue({ now: at(10) })).length, 1);

        yield* jobs.tryReserveForRemoval({
          threadId: cleanup.threadId,
          canonicalWorktreePath: "/tmp/retry",
          reservedAt: at(10),
        });
        const secondFailure = yield* jobs.recordFailure({
          threadId: cleanup.threadId,
          error: "git still unavailable",
          reason: "git-command-failed",
          now: at(11),
          nextAttemptAt: at(20),
          maxAttempts: 2,
        });
        assert.equal(secondFailure.pipe(Option.getOrThrow).status, "needs-attention");
        assert.isFalse(yield* jobs.hasReservationByPath("/tmp/retry"));
        assert.deepEqual(yield* jobs.listDue({ now: at(100) }), []);
      }),
  );

  it.effect("preserves explicit cancellation and does not reactivate cancelled rows", () =>
    Effect.gen(function* () {
      const jobs = yield* WorktreeCleanupJobRepository;
      const cleanup = yield* jobs.enqueue(
        intent({ id: "cleanup-cancelled", path: "/tmp/cancelled" }),
      );
      yield* jobs.tryReserveForRemoval({
        threadId: cleanup.threadId,
        canonicalWorktreePath: "/tmp/cancelled",
        reservedAt: at(0),
      });
      yield* jobs.cancelByThreadId(cleanup.threadId);

      const cancelled = yield* jobs.getByThreadId(cleanup.threadId);
      assert.equal(cancelled.pipe(Option.getOrThrow).status, "cancelled");
      assert.isFalse(yield* jobs.hasReservationByPath("/tmp/cancelled"));

      const reenqueue = yield* jobs.enqueue(
        intent({ id: "cleanup-cancelled", path: "/tmp/cancelled", source: "delete" }),
      );
      assert.equal(reenqueue.status, "cancelled");
      assert.equal(
        (yield* jobs.getByThreadId(cleanup.threadId)).pipe(Option.getOrThrow).status,
        "cancelled",
      );
    }),
  );

  it.effect("keeps legacy projection upserts manual-review and non-reactivating", () =>
    Effect.gen(function* () {
      const jobs = yield* WorktreeCleanupJobRepository;
      const threadId = ThreadId.make("legacy-cleanup");
      const input = {
        threadId,
        cwd: "/tmp/project",
        worktreePath: "/tmp/legacy",
        requestedAt: at(0),
      };

      yield* jobs.upsert(input);
      const legacy = yield* jobs.getByThreadId(threadId);
      assert.equal(legacy.pipe(Option.getOrThrow).source, "legacy");
      assert.equal(legacy.pipe(Option.getOrThrow).status, "needs-attention");
      assert.isFalse(yield* jobs.existsByPath("/tmp/legacy"));

      yield* jobs.cancelByThreadId(threadId);
      yield* jobs.upsert({ ...input, worktreePath: "/tmp/legacy-renamed" });
      const cancelled = yield* jobs.getByThreadId(threadId);
      assert.equal(cancelled.pipe(Option.getOrThrow).status, "cancelled");
      assert.equal(cancelled.pipe(Option.getOrThrow).worktreePath, "/tmp/legacy");
    }),
  );
});
