import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "066_ProjectionThreadsPullRequest",
  (it) => {
    it.effect("adds pull_request_json defaulting legacy rows to null without backfill", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 65 });

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        ) VALUES (
          'thread-legacy',
          'project-1',
          'Legacy',
          '{"model":"gpt","instanceId":"codex"}',
          'full-access',
          'default',
          'feature/shared',
          NULL,
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 66 });

        const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
        assert.isTrue(columns.some((column) => column.name === "pull_request_json"));

        const rows = yield* sql<{ readonly pullRequestJson: string }>`
        SELECT pull_request_json AS "pullRequestJson"
        FROM projection_threads
        WHERE thread_id = 'thread-legacy'
      `;
        assert.deepStrictEqual(rows, [{ pullRequestJson: "null" }]);
      }),
    );
  },
);
