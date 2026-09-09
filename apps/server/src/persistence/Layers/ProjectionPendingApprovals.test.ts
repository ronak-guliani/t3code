import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectionPendingApprovalRepository } from "../Services/ProjectionPendingApprovals.ts";
import { ProjectionPendingApprovalRepositoryLive } from "./ProjectionPendingApprovals.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionPendingApprovalRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionPendingApprovalRepository", (it) => {
  it.effect("counts only approvals still awaiting a decision", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingApprovalRepository;
      const threadId = ThreadId.make("thread-count-pending-approvals");

      assert.strictEqual(yield* repository.countPendingByThreadId({ threadId }), 0);

      yield* repository.upsert({
        requestId: ApprovalRequestId.make("approval-count-pending-1"),
        threadId,
        turnId: null,
        status: "pending",
        decision: null,
        createdAt: "2026-03-02T00:00:01.000Z",
        resolvedAt: null,
      });
      yield* repository.upsert({
        requestId: ApprovalRequestId.make("approval-count-pending-2"),
        threadId,
        turnId: null,
        status: "pending",
        decision: null,
        createdAt: "2026-03-02T00:00:02.000Z",
        resolvedAt: null,
      });
      yield* repository.upsert({
        requestId: ApprovalRequestId.make("approval-count-resolved"),
        threadId,
        turnId: null,
        status: "resolved",
        decision: "accept",
        createdAt: "2026-03-02T00:00:03.000Z",
        resolvedAt: "2026-03-02T00:00:04.000Z",
      });
      yield* repository.upsert({
        requestId: ApprovalRequestId.make("approval-count-other-thread"),
        threadId: ThreadId.make("thread-count-pending-approvals-other"),
        turnId: null,
        status: "pending",
        decision: null,
        createdAt: "2026-03-02T00:00:05.000Z",
        resolvedAt: null,
      });

      assert.strictEqual(yield* repository.countPendingByThreadId({ threadId }), 2);
    }),
  );
});
