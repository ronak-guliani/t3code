import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable PR monitor feedback items, revisions, deliveries, and disposition
 * audit. Delivery is logical exactly-once via deterministic command/message IDs
 * and durable receipts; agents never own polling correctness.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_monitor_feedback_items (
      item_id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      stable_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      disposition TEXT,
      disposition_note TEXT,
      disposition_at TEXT,
      disposition_by_thread_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      current_revision_id TEXT,
      UNIQUE (monitor_id, stable_key),
      FOREIGN KEY (monitor_id) REFERENCES pull_request_monitors(monitor_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_monitor_feedback_items_monitor
    ON pull_request_monitor_feedback_items(monitor_id, status, last_seen_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_monitor_feedback_revisions (
      revision_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      created_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      UNIQUE (item_id, revision_number),
      FOREIGN KEY (item_id) REFERENCES pull_request_monitor_feedback_items(item_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_monitor_feedback_deliveries (
      delivery_id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      batch_key TEXT NOT NULL UNIQUE,
      target_thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      revision_ids_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      receipt_json TEXT,
      FOREIGN KEY (monitor_id) REFERENCES pull_request_monitors(monitor_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_monitor_feedback_deliveries_due
    ON pull_request_monitor_feedback_deliveries(status, next_attempt_at)
    WHERE status IN ('pending', 'failed')
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_monitor_feedback_reports (
      report_id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      disposition TEXT NOT NULL,
      note TEXT,
      reporter_thread_id TEXT,
      created_at TEXT NOT NULL,
      recheck_requested INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (monitor_id) REFERENCES pull_request_monitors(monitor_id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES pull_request_monitor_feedback_items(item_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_monitor_feedback_reports_monitor
    ON pull_request_monitor_feedback_reports(monitor_id, created_at DESC)
  `;

  // Debounce / circuit-breaker state per monitor.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_monitor_feedback_state (
      monitor_id TEXT PRIMARY KEY,
      pending_revision_ids_json TEXT NOT NULL DEFAULT '[]',
      debounce_until TEXT,
      delivery_failure_count INTEGER NOT NULL DEFAULT 0,
      circuit_open_until TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (monitor_id) REFERENCES pull_request_monitors(monitor_id) ON DELETE CASCADE
    )
  `;
});
