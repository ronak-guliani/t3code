import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_thread_id TEXT,
      thread_url TEXT,
      title TEXT NOT NULL,
      model_selection_json TEXT NOT NULL DEFAULT '{}',
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      pending_runtime_mode TEXT,
      interaction_mode TEXT NOT NULL DEFAULT 'default',
      branch TEXT,
      worktree_path TEXT,
      pull_request_json TEXT NOT NULL DEFAULT 'null',
      review_snapshot_json TEXT NOT NULL DEFAULT 'null',
      review_result_json TEXT NOT NULL DEFAULT 'null',
      latest_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      settled_override TEXT,
      settled_at TEXT,
      snoozed_until TEXT,
      snoozed_at TEXT,
      latest_user_message_at TEXT,
      latest_child_notification_at TEXT,
      pending_approval_count INTEGER NOT NULL DEFAULT 0,
      pending_user_input_count INTEGER NOT NULL DEFAULT 0,
      has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT
    )
  `;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("thread_url")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN thread_url TEXT`;
  }
  if (!names.has("latest_child_notification_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN latest_child_notification_at TEXT`;
  }
});
