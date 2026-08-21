import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "081_ChildLifecycleNotificationDedup",
  (it) => {
    it.effect("backfills existing lifecycle keys and enforces semantic uniqueness", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 80 });
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

        yield* runMigrations({ toMigrationInclusive: 81 });

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

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "081_ChildLifecycleNotificationDedup divergent ledger",
  (it) => {
    it.effect("repairs schemas skipped by the previous branch migration ledger", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 76 });
        yield* sql`ALTER TABLE projection_threads ADD COLUMN thread_url TEXT`;
        yield* sql`ALTER TABLE projection_threads ADD COLUMN latest_child_notification_at TEXT`;
        yield* sql`
          CREATE TABLE child_lifecycle_notification_dedup (
            dedupe_key TEXT PRIMARY KEY,
            event_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
          )
        `;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES
            (77, 'ChildLifecycleNotifications'),
            (78, 'ChildLifecycleNotificationDedup'),
            (79, 'ProjectionThreadCompatibilityRepair'),
            (80, 'ChildLifecycleNotificationDedup')
        `;

        yield* runMigrations({ toMigrationInclusive: 81 });

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_threads)
        `;
        const names = new Set(columns.map((column) => column.name));
        assert.isTrue(names.has("pinned_at"));
        assert.isTrue(names.has("pin_order_key"));
        assert.isTrue(names.has("title_regeneration_request_id"));
        assert.isTrue(names.has("title_regeneration_started_at"));
        assert.isTrue(names.has("thread_url"));
        assert.isTrue(names.has("latest_child_notification_at"));

        const pairingLinkColumns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(auth_pairing_links)
        `;
        const sessionColumns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(auth_sessions)
        `;
        assert.isTrue(pairingLinkColumns.some(({ name }) => name === "proof_key_thumbprint"));
        assert.isTrue(sessionColumns.some(({ name }) => name === "proof_key_thumbprint"));
      }),
    );
  },
);
