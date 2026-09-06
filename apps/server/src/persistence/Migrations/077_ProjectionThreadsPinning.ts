import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionCore from "./005_Projections.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ProjectionCore;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has("parent_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
  }
  if (!names.has("model_selection_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN model_selection_json TEXT`;
  }
  if (!names.has("runtime_mode")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'full-access'
    `;
  }
  if (!names.has("pending_runtime_mode")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN pending_runtime_mode TEXT`;
  }
  if (!names.has("interaction_mode")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'default'
    `;
  }
  if (!names.has("pull_request_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pull_request_json TEXT NOT NULL DEFAULT 'null'
    `;
  }
  if (!names.has("review_snapshot_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN review_snapshot_json TEXT NOT NULL DEFAULT 'null'
    `;
  }
  if (!names.has("review_result_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN review_result_json TEXT NOT NULL DEFAULT 'null'
    `;
  }
  if (!names.has("archived_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN archived_at TEXT`;
  }
  if (!names.has("settled_override")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN settled_override TEXT`;
  }
  if (!names.has("settled_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN settled_at TEXT`;
  }
  if (!names.has("snoozed_until")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN snoozed_until TEXT`;
  }
  if (!names.has("snoozed_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN snoozed_at TEXT`;
  }
  if (!names.has("pinned_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN pinned_at TEXT`;
  }
  if (!names.has("pin_order_key")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN pin_order_key TEXT`;
  }
  if (!names.has("latest_user_message_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN latest_user_message_at TEXT`;
  }
  if (!names.has("pending_approval_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_approval_count INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!names.has("pending_user_input_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_user_input_count INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!names.has("has_actionable_proposed_plan")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0
    `;
  }
});
