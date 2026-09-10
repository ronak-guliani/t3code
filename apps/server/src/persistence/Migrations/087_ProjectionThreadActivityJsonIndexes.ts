import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Indexes hot activity JSON paths and turn-scoped chronology.
 *
 * Snapshot queries partition and filter by `taskId` / `requestId` / `taskType`
 * extracted from `payload_json` on every snapshot, and page turn timelines via
 * `(thread_id, turn_id, created_at)`. `json_extract` in WHERE / PARTITION BY /
 * correlated EXISTS cannot use the existing `(thread_id, created_at)` indexes,
 * so `listThreadActivityRows`, `listBackgroundAgentActivityRows*`, and
 * `listThreadActivityContextRows` scanned and sorted far more rows than they
 * returned.
 *
 * Stored generated columns make those paths indexable without changing the
 * write path (INSERT column lists are untouched; SQLite maintains the values).
 * They are VIRTUAL (SQLite refuses to ADD a STORED column to an existing
 * table) with supporting indexes that materialize the computed values for
 * lookups. The expressions are guarded by json_valid: payloads are not
 * guaranteed to be valid JSON (snapshot capping happens before decode, so
 * invalid rows exist), and a bare json_extract would fail their INSERTs.
 * Column adds are PRAGMA-guarded so divergent ledgers that already carry them
 * stay idempotent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // NB: generated columns are hidden from PRAGMA table_info (use table_xinfo),
  // so a table_info guard would re-run ADD COLUMN and fail with a duplicate
  // column error on divergent ledgers.
  const activityColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_xinfo(projection_thread_activities)
  `;
  const hasColumn = (name: string) => activityColumns.some((column) => column.name === name);

  if (!hasColumn("task_id")) {
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN task_id TEXT GENERATED ALWAYS AS (
        CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.taskId') END
      ) VIRTUAL
    `;
  }

  if (!hasColumn("request_id")) {
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN request_id TEXT GENERATED ALWAYS AS (
        CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.requestId') END
      ) VIRTUAL
    `;
  }

  if (!hasColumn("task_type")) {
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN task_type TEXT GENERATED ALWAYS AS (
        CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.taskType') END
      ) VIRTUAL
    `;
  }

  // Turn-timeline keyset pagination: listTurnActivityRowsBeforeActivity and
  // findTurnActivityBeforeActivity filter (thread_id, turn_id) and order by
  // (created_at, activity_id).
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_turn_created
    ON projection_thread_activities(thread_id, turn_id, created_at DESC, activity_id DESC)
  `;

  // Background-agent lifecycle lookups filter (thread_id, kind) and group by
  // task id; the stored column replaces the unindexable json_extract.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_kind_task
    ON projection_thread_activities(thread_id, kind, task_id, created_at DESC, activity_id DESC)
    WHERE task_id IS NOT NULL
  `;

  // Approval / user-input lifecycle windows partition by request id.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_kind_request
    ON projection_thread_activities(thread_id, kind, request_id, created_at DESC, activity_id DESC)
    WHERE request_id IS NOT NULL
  `;
});
