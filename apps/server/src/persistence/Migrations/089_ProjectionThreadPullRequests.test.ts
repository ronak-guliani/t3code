import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("089_ProjectionThreadPullRequests", (it) => {
  it.effect("backfills a real GitPullRequestAssociation payload", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-14T00:00:00.000Z";
      const pullRequest = {
        number: 42,
        title: "Existing workspace PR",
        url: "https://github.com/acme/example/pull/42",
        baseBranch: "main",
        headBranch: "feature/multi-pr",
        state: "open",
      };

      yield* runMigrations({ toMigrationInclusive: 87 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          branch,
          worktree_path,
          created_at,
          updated_at,
          deleted_at,
          pull_request_json
        ) VALUES (
          'thread-backfill',
          'project-1',
          'Backfill',
          '{"provider":"codex","model":"gpt-5.3-codex"}',
          'feature/multi-pr',
          '/tmp/multi-pr',
          ${now},
          ${now},
          NULL,
          ${JSON.stringify(pullRequest)}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 89 });

      const rows = yield* sql<{
        readonly thread_id: string;
        readonly host: string;
        readonly repository: string;
        readonly number: number;
        readonly pull_request_json: string;
        readonly source: string;
        readonly linked_at: string;
      }>`
        SELECT
          thread_id,
          host,
          repository,
          number,
          pull_request_json,
          source,
          linked_at
        FROM projection_thread_pull_requests
      `;
      assert.deepStrictEqual(rows, [
        {
          thread_id: "thread-backfill",
          host: "github.com",
          repository: "acme/example",
          number: 42,
          pull_request_json: JSON.stringify(pullRequest),
          source: "created",
          linked_at: now,
        },
      ]);
    }),
  );
});
