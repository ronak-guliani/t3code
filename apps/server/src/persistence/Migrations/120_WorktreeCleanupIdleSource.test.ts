import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("allows idle cleanup jobs and preserves an in-flight removal reservation", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 119 });
    yield* sql`
      INSERT INTO worktree_cleanup_jobs (
        thread_id, cwd, worktree_path, canonical_worktree_path, requested_at, source,
        status, attempt_count, next_attempt_at, last_reason, last_error
      ) VALUES (
        'removing-thread', '/repo', '/repo-wt', '/repo-wt', '2026-01-01T00:00:00.000Z',
        'archive', 'removing', 2, NULL, 'in-flight', NULL
      )
    `;
    yield* sql`
      INSERT INTO worktree_cleanup_reservations (
        canonical_worktree_path, thread_id, reserved_at
      ) VALUES ('/repo-wt', 'removing-thread', '2026-01-01T00:00:00.000Z')
    `;

    yield* runMigrations({ toMigrationInclusive: 120 });
    yield* sql`
      INSERT INTO worktree_cleanup_jobs (
        thread_id, cwd, worktree_path, canonical_worktree_path, requested_at, source,
        status, attempt_count
      ) VALUES (
        'idle-thread', '/repo', '/idle-wt', '/idle-wt', '2026-01-01T00:00:00.000Z',
        'idle', 'waiting', 0
      )
    `;

    const reservation = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId"
      FROM worktree_cleanup_reservations
      WHERE canonical_worktree_path = '/repo-wt'
    `;
    const sources = yield* sql<{ readonly source: string }>`
      SELECT source FROM worktree_cleanup_jobs ORDER BY thread_id
    `;

    // The table rebuild drops every index; the due-sweep index must come back in
    // the partial form introduced by migration 119.
    const dueIndex = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_worktree_cleanup_jobs_due'
    `;

    assert.deepStrictEqual(reservation, [{ threadId: "removing-thread" }]);
    assert.match(
      dueIndex[0]?.sql ?? "",
      /\(next_attempt_at, requested_at, thread_id\)\s+WHERE status = 'waiting'/,
    );
    assert.deepStrictEqual(sources, [{ source: "idle" }, { source: "archive" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
