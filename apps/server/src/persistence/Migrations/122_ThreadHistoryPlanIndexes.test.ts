import { it, assert } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";

// A thread-only plan scan/sort grows with discarded history. Both scoped
// ownership and the independent latest-plan seek need upgrade-safe indexes.
it.effect("indexes scoped and latest plan reads on a migrated database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const owned =
      yield* sql`EXPLAIN QUERY PLAN SELECT plan_id FROM projection_thread_proposed_plans WHERE thread_id='thread' AND turn_id IN ('turn')`;
    const latest =
      yield* sql`EXPLAIN QUERY PLAN SELECT plan_id FROM projection_thread_proposed_plans WHERE thread_id='thread' ORDER BY updated_at DESC,plan_id DESC LIMIT 1`;
    assert.isTrue(owned.some((r) => String(r.detail).includes("idx_projection_thread_plans_turn")));
    assert.isTrue(
      latest.some((r) => String(r.detail).includes("idx_projection_thread_plans_latest")),
    );
    assert.isFalse(latest.some((r) => String(r.detail).includes("TEMP B-TREE")));
  }).pipe(Effect.provide(Layer.fresh(SqlitePersistenceMemory))),
);
