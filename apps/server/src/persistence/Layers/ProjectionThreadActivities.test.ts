import { EventId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("lists only user-input lifecycle activities in chronological order", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-user-input-lifecycle");

      const seed = (suffix: string, kind: string, createdAt: string, payload: unknown) =>
        repository.upsert({
          activityId: EventId.make(`activity-user-input-${suffix}`),
          threadId,
          turnId: null,
          tone: "approval",
          kind,
          summary: suffix,
          payload,
          createdAt,
        });

      yield* seed("requested", "user-input.requested", "2026-03-02T00:00:01.000Z", {
        requestId: "user-input-1",
      });
      yield* seed("unrelated", "approval.requested", "2026-03-02T00:00:02.000Z", {
        requestKind: "command",
      });
      yield* seed(
        "failed-stale",
        "provider.user-input.respond.failed",
        "2026-03-02T00:00:03.000Z",
        { requestId: "user-input-stale", detail: "stale pending user-input request" },
      );
      yield* seed("resolved", "user-input.resolved", "2026-03-02T00:00:04.000Z", {
        requestId: "user-input-1",
      });

      const rows = yield* repository.listUserInputLifecycleByThreadId({ threadId });
      assert.deepStrictEqual(
        rows.map((row) => row.kind),
        ["user-input.requested", "provider.user-input.respond.failed", "user-input.resolved"],
      );
      assert.deepStrictEqual(rows[0]?.payload, { requestId: "user-input-1" });
      for (const row of rows) {
        assert.notProperty(row, "summary");
        assert.notProperty(row, "tone");
      }
    }),
  );
});
