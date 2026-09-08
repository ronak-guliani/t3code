import { ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectionThreadProposedPlanRepository } from "../Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "./ProjectionThreadProposedPlans.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadProposedPlanRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadProposedPlanRepository", (it) => {
  it.effect("lists plan summaries without plan markdown", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadProposedPlanRepository;
      const threadId = ThreadId.make("thread-plan-summaries");
      const turnId = TurnId.make("turn-plan-summaries");

      yield* repository.upsert({
        planId: "plan-summary-older",
        threadId,
        turnId,
        planMarkdown: "older plan body",
        implementedAt: "2026-03-02T00:00:02.000Z",
        implementationThreadId: null,
        createdAt: "2026-03-02T00:00:01.000Z",
        updatedAt: "2026-03-02T00:00:02.000Z",
      });
      yield* repository.upsert({
        planId: "plan-summary-newer",
        threadId,
        turnId,
        planMarkdown: "newer plan body",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-03-02T00:00:03.000Z",
        updatedAt: "2026-03-02T00:00:04.000Z",
      });

      const summaries = yield* repository.listSummariesByThreadId({ threadId });
      assert.strictEqual(summaries.length, 2);
      assert.strictEqual(summaries[0]?.planId, "plan-summary-older");
      assert.strictEqual(summaries[1]?.planId, "plan-summary-newer");
      for (const summary of summaries) {
        assert.notProperty(summary, "planMarkdown");
        assert.strictEqual(summary.threadId, threadId);
      }
      assert.strictEqual(summaries[1]?.implementedAt, null);
    }),
  );
});
