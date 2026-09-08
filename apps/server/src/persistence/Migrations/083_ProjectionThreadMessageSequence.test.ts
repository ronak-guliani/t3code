import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ProjectionThreadMessageSequence from "./083_ProjectionThreadMessageSequence.ts";

const seedMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
    )
    VALUES
      ('message-a', 'thread-a', NULL, 'user', 'first', 0, '2026-09-05', '2026-09-05'),
      ('message-b', 'thread-a', NULL, 'user', 'second', 0, '2026-09-05', '2026-09-05'),
      ('legacy', 'thread-a', NULL, 'user', 'legacy', 0, '2026-09-05', '2026-09-05')
  `;
  yield* sql`
    INSERT INTO orchestration_events (
      sequence, event_id, aggregate_kind, stream_id, stream_version,
      event_type, occurred_at, actor_kind, payload_json, metadata_json
    )
    VALUES
      (1, 'event-other', 'thread', 'thread-a', 1,
       'thread.turn-start-requested', '2026-09-05', 'user', '{"messageId":"message-a"}', '{}'),
      (2, 'event-a', 'thread', 'thread-a', 2,
       'thread.message-sent', '2026-09-05', 'user', '{"messageId":"message-a"}', '{}'),
      (3, 'event-b', 'thread', 'thread-a', 3,
       'thread.message-sent', '2026-09-05', 'user', '{"messageId":"message-b"}', '{}'),
      (4, 'event-a-update', 'thread', 'thread-a', 4,
       'thread.message-sent', '2026-09-05', 'user', '{"messageId":"message-a"}', '{}'),
      (5, 'event-deleted', 'thread', 'thread-a', 5,
       'thread.message-sent', '2026-09-05', 'user', '{"messageId":"deleted"}', '{}')
  `;
});

const readSequences = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly message_id: string; readonly sequence: number | null }>`
    SELECT message_id, sequence FROM projection_thread_messages ORDER BY message_id
  `;
});

it.effect("backfills the first message event and leaves unmatched legacy rows unsequenced", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 82 });
    yield* seedMessages;
    yield* runMigrations({ toMigrationInclusive: 83 });

    assert.deepStrictEqual(yield* readSequences, [
      { message_id: "legacy", sequence: null },
      { message_id: "message-a", sequence: 2 },
      { message_id: "message-b", sequence: 3 },
    ]);

    yield* ProjectionThreadMessageSequence;
    assert.deepStrictEqual(yield* readSequences, [
      { message_id: "legacy", sequence: null },
      { message_id: "message-a", sequence: 2 },
      { message_id: "message-b", sequence: 3 },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("repairs an existing sequence column without overwriting populated sequences", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 82 });
    yield* seedMessages;
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN sequence INTEGER`;
    yield* sql`UPDATE projection_thread_messages SET sequence = 99 WHERE message_id = 'message-a'`;

    yield* runMigrations({ toMigrationInclusive: 83 });
    assert.deepStrictEqual(yield* readSequences, [
      { message_id: "legacy", sequence: null },
      { message_id: "message-a", sequence: 99 },
      { message_id: "message-b", sequence: 3 },
    ]);

    const indexes = yield* sql<{ readonly name: string }>`
      PRAGMA index_list(projection_thread_messages)
    `;
    assert.isTrue(
      indexes.some(({ name }) => name === "idx_projection_thread_messages_thread_sequence"),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("restores a missing message table after the migration ledger has advanced", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 82 });
    yield* sql`DROP TABLE projection_thread_messages`;

    yield* runMigrations({ toMigrationInclusive: 83 });
    const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(projection_thread_messages)
    `;
    for (const name of ["message_id", "attachments_json", "origin_json", "sequence"]) {
      assert.isTrue(columns.some((column) => column.name === name));
    }
    yield* ProjectionThreadMessageSequence;
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
