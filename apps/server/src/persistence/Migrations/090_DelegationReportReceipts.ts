import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS delegation_report_receipts (
      report_key TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      dispatch_id TEXT,
      origin_turn_id TEXT,
      report_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'stale')),
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegation_report_receipts_command
    ON delegation_report_receipts(command_id)
  `;

  yield* sql`
    INSERT OR IGNORE INTO delegation_report_receipts (
      report_key,
      command_id,
      child_thread_id,
      assignment_id,
      dispatch_id,
      origin_turn_id,
      report_id,
      outcome,
      created_at
    )
    SELECT
      CASE
        WHEN json_extract(payload_json, '$.activity.payload.dispatchId') IS NOT NULL THEN
          'report:' || stream_id || ':' ||
          json_extract(payload_json, '$.activity.payload.dispatchId') || ':' ||
          json_extract(payload_json, '$.activity.payload.assignmentId') || ':' ||
          json_extract(payload_json, '$.activity.payload.reportId')
        WHEN json_extract(payload_json, '$.activity.payload.originTurnId') IS NOT NULL THEN
          'report:' || stream_id || ':turn:' ||
          json_extract(payload_json, '$.activity.payload.originTurnId') || ':' ||
          json_extract(payload_json, '$.activity.payload.assignmentId') || ':' ||
          json_extract(payload_json, '$.activity.payload.reportId')
        ELSE
          'report:' || stream_id || ':' ||
          json_extract(payload_json, '$.activity.payload.assignmentId') || ':' ||
          json_extract(payload_json, '$.activity.payload.reportId')
      END,
      command_id,
      stream_id,
      json_extract(payload_json, '$.activity.payload.assignmentId'),
      json_extract(payload_json, '$.activity.payload.dispatchId'),
      json_extract(payload_json, '$.activity.payload.originTurnId'),
      json_extract(payload_json, '$.activity.payload.reportId'),
      json_extract(payload_json, '$.activity.payload.dispatchVerdict'),
      occurred_at
    FROM orchestration_events
    WHERE event_type = 'thread.activity-appended'
      AND json_valid(payload_json)
      AND json_extract(payload_json, '$.activity.kind') = 'delegation.reported'
      AND json_type(payload_json, '$.activity.payload.assignmentId') = 'text'
      AND json_type(payload_json, '$.activity.payload.reportId') = 'text'
      AND json_extract(payload_json, '$.activity.payload.dispatchVerdict') IN ('accepted', 'stale')
      AND command_id IS NOT NULL
    ORDER BY sequence ASC
  `;
});
