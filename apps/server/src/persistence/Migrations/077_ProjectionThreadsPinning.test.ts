import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("077_ProjectionThreadsPinning", (it) => {
  it.effect("adds pin projection columns idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 77 });
      yield* runMigrations({ toMigrationInclusive: 77 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = new Set(columns.map((column) => column.name));
      assert.isTrue(names.has("pinned_at"));
      assert.isTrue(names.has("pin_order_key"));
    }),
  );

  it.effect("restores the current thread projection after a skipped-table ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      yield* sql`DROP TABLE projection_threads`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 77`;

      yield* runMigrations({ toMigrationInclusive: 77 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = new Set(columns.map((column) => column.name));
      for (const name of [
        "thread_id",
        "project_id",
        "parent_thread_id",
        "title",
        "model_selection_json",
        "runtime_mode",
        "pending_runtime_mode",
        "interaction_mode",
        "pull_request_json",
        "review_snapshot_json",
        "review_result_json",
        "archived_at",
        "settled_override",
        "settled_at",
        "snoozed_until",
        "snoozed_at",
        "pinned_at",
        "pin_order_key",
        "latest_user_message_at",
        "pending_approval_count",
        "pending_user_input_count",
        "has_actionable_proposed_plan",
      ]) {
        assert.isTrue(names.has(name), `Expected projection_threads.${name}`);
      }
    }),
  );
});
