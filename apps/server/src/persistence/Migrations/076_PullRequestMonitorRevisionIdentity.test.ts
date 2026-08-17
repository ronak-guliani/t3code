import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "076_PullRequestMonitorRevisionIdentity",
  (it) => {
    it.effect("adds source-content revision identity idempotently", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 76 });
        yield* runMigrations({ toMigrationInclusive: 76 });

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(pull_request_monitor_feedback_revisions)
        `;
        assert.isTrue(columns.some((column) => column.name === "content_hash"));

        const launchColumns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(pull_request_monitor_fallback_launches)
        `;
        assert.isTrue(launchColumns.some((column) => column.name === "updated_at"));
      }),
    );

    it.effect("rejects a duplicate observation of the same source content", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 76 });

        yield* sql`
          INSERT INTO pull_request_monitors (
            monitor_id, canonical_key, provider, host, repository, number, project_id,
            status, enabled, poll_failure_count, created_at, updated_at
          ) VALUES (
            'mon-1', 'github|github.com|acme/app|12', 'github', 'github.com', 'acme/app', 12,
            'proj-1', 'monitoring', 1, 0, 'now', 'now'
          )
        `;
        yield* sql`
          INSERT INTO pull_request_monitor_feedback_items (
            item_id, monitor_id, stable_key, kind, status, first_seen_at, last_seen_at
          ) VALUES ('item-1', 'mon-1', 'check-failed:ci', 'check-failed', 'open', 'now', 'now')
        `;
        const insertRevision = (revisionId: string) => sql`
          INSERT INTO pull_request_monitor_feedback_revisions (
            revision_id, item_id, revision_number, payload_json, source_revision, content_hash,
            head_sha, created_at, summary
          ) VALUES (
            ${revisionId}, 'item-1', 1, '{}', 'rev-1', 'hash-1', 'head-1', 'now', 'check-failed: ci'
          )
        `;

        yield* insertRevision("rev-row-1");
        const duplicate = yield* Effect.result(insertRevision("rev-row-2"));
        assert.strictEqual(duplicate._tag, "Failure");

        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM pull_request_monitor_feedback_revisions
        `;
        assert.strictEqual(rows[0]?.count, 1);
      }),
    );
  },
);
