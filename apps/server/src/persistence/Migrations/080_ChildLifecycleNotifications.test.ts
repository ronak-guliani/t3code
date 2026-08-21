import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "080_ChildLifecycleNotifications",
  (it) => {
    it.effect("adds notification state and backfills existing lifecycle dedupe keys", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 79 });

        const beforeColumns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_threads)
        `;
        assert.isFalse(beforeColumns.some(({ name }) => name === "latest_child_notification_at"));

        yield* sql`
          INSERT INTO orchestration_events (
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            command_id,
            causation_event_id,
            correlation_id,
            actor_kind,
            payload_json,
            metadata_json
          )
          VALUES (
            'event-lifecycle-existing',
            'thread',
            'parent-thread',
            1,
            'thread.child-lifecycle-notified',
            '2026-07-30T00:00:00.000Z',
            'command-existing',
            NULL,
            NULL,
            'server',
            '{"dedupeKey":"child:child-thread:completed:turn-1"}',
            '{}'
          )
        `;

        yield* runMigrations({ toMigrationInclusive: 80 });

        const afterColumns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_threads)
        `;
        assert.isTrue(afterColumns.some(({ name }) => name === "latest_child_notification_at"));
        assert.isFalse(afterColumns.some(({ name }) => name === "thread_url"));

        const rows = yield* sql<{
          readonly dedupe_key: string;
          readonly event_id: string;
        }>`
          SELECT dedupe_key, event_id
          FROM child_lifecycle_notification_dedup
        `;
        assert.deepStrictEqual(rows, [
          {
            dedupe_key: "child:child-thread:completed:turn-1",
            event_id: "event-lifecycle-existing",
          },
        ]);

        const duplicate = yield* Effect.result(sql`
          INSERT INTO child_lifecycle_notification_dedup (
            dedupe_key,
            event_id,
            created_at
          )
          VALUES (
            'child:child-thread:completed:turn-1',
            'event-lifecycle-retry',
            '2026-07-30T01:00:00.000Z'
          )
        `);
        assert.strictEqual(duplicate._tag, "Failure");
      }),
    );
  },
);
