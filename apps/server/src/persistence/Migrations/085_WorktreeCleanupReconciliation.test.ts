import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("085_WorktreeCleanupReconciliation", (it) => {
  it.effect("upgrades legacy rows without reactivating cancelled cleanup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 84 });
      yield* sql`
        INSERT INTO worktree_cleanup_jobs (
          thread_id,
          cwd,
          worktree_path,
          requested_at,
          status,
          attempt_count,
          last_error
        )
        VALUES
          ('legacy-pending', '/tmp/project', '/tmp/pending', '1970-01-01T00:00:00.000Z', 'pending', 2, NULL),
          ('legacy-cancelled', '/tmp/project', '/tmp/cancelled', '1970-01-01T00:00:01.000Z', 'cancelled', 3, 'user cancelled')
      `;

      yield* runMigrations({ toMigrationInclusive: 85 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(worktree_cleanup_jobs)
      `;
      assert.deepEqual(
        columns.map(({ name }) => name),
        [
          "thread_id",
          "cwd",
          "worktree_path",
          "canonical_worktree_path",
          "requested_at",
          "source",
          "status",
          "attempt_count",
          "next_attempt_at",
          "last_reason",
          "last_error",
        ],
      );

      const rows = yield* sql<{
        readonly threadId: string;
        readonly source: string;
        readonly status: string;
        readonly attemptCount: number;
        readonly lastReason: string | null;
        readonly lastError: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          source,
          status,
          attempt_count AS "attemptCount",
          last_reason AS "lastReason",
          last_error AS "lastError"
        FROM worktree_cleanup_jobs
        ORDER BY thread_id
      `;
      assert.deepEqual(rows, [
        {
          threadId: "legacy-cancelled",
          source: "legacy",
          status: "cancelled",
          attemptCount: 3,
          lastReason: "cancelled-before-reconciliation",
          lastError: "user cancelled",
        },
        {
          threadId: "legacy-pending",
          source: "legacy",
          status: "needs-attention",
          attemptCount: 2,
          lastReason: "legacy-cleanup-intent-requires-review",
          lastError: null,
        },
      ]);

      const reservationTable = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'worktree_cleanup_reservations'
      `;
      assert.deepEqual(reservationTable, [{ name: "worktree_cleanup_reservations" }]);
    }),
  );
});
