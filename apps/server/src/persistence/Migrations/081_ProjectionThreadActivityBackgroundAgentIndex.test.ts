import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("081_ProjectionThreadActivityBackgroundAgentIndex", (it) => {
  it.effect("uses the lifecycle index for shell snapshots", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 81 });

      const queryPlan = yield* sql<{
        readonly detail: string;
      }>`
        EXPLAIN QUERY PLAN
        SELECT
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        FROM projection_thread_activities
        WHERE kind IN ('task.started', 'task.completed')
        ORDER BY thread_id ASC, created_at ASC, activity_id ASC
      `;

      assert.ok(
        queryPlan.some((row) =>
          row.detail.includes("idx_projection_thread_activities_background_agent_lifecycle"),
        ),
      );
      assert.ok(queryPlan.every((row) => !row.detail.includes("USE TEMP B-TREE")));
    }),
  );
});
