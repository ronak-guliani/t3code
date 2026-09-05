import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Projections from "./005_Projections.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* Projections;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  // A recreated table also needs the message columns from skipped migrations.
  for (const [name, type] of [
    ["attachments_json", "TEXT"],
    ["origin_json", "TEXT"],
    ["sequence", "INTEGER"],
  ] as const) {
    if (!columns.some((column) => column.name === name)) {
      yield* sql`
        ALTER TABLE projection_thread_messages
        ADD COLUMN ${sql.literal(name)} ${sql.literal(type)}
      `;
    }
  }

  // Scan event JSON once, then join by message ID instead of rescanning per row.
  yield* sql`
    WITH message_sequences AS MATERIALIZED (
      SELECT
        json_extract(payload_json, '$.messageId') AS message_id,
        MIN(sequence) AS sequence
      FROM orchestration_events
      WHERE event_type = 'thread.message-sent'
      GROUP BY json_extract(payload_json, '$.messageId')
    )
    UPDATE projection_thread_messages
    SET sequence = message_sequences.sequence
    FROM message_sequences
    WHERE projection_thread_messages.message_id = message_sequences.message_id
      AND projection_thread_messages.sequence IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_sequence
    ON projection_thread_messages(thread_id, sequence)
  `;
});
