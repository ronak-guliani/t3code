import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS child_lifecycle_notification_dedup (
      dedupe_key TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO child_lifecycle_notification_dedup (
      dedupe_key,
      event_id,
      created_at
    )
    SELECT
      json_extract(payload_json, '$.dedupeKey'),
      event_id,
      occurred_at
    FROM orchestration_events
    WHERE event_type = 'thread.child-lifecycle-notified'
      AND json_type(payload_json, '$.dedupeKey') = 'text'
  `;
});
