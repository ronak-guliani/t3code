import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("indexes due waiting cleanup jobs by their sweep order", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();

    const rows = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_worktree_cleanup_jobs_due'
    `;
    assert.equal(rows.length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
