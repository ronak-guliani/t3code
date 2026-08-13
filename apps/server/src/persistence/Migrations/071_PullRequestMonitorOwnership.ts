import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import PullRequestMonitors from "./069_PullRequestMonitors.ts";

/**
 * Ownership and review-handoff metadata for PR monitors.
 * One modifying owner at a time; review threads are linked, not concurrent owners.
 *
 * Divergent ledgers can skip 069 while still advancing past it; ensure the
 * monitors table exists before ALTER, and only add the column when absent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* PullRequestMonitors;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(pull_request_monitors)
  `;
  if (!columns.some((column) => column.name === "linked_review_thread_id")) {
    yield* sql`
      ALTER TABLE pull_request_monitors
      ADD COLUMN linked_review_thread_id TEXT
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_monitor_ownership_events (
      event_id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      from_thread_id TEXT,
      to_thread_id TEXT,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (monitor_id) REFERENCES pull_request_monitors(monitor_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_monitor_ownership_events_monitor
    ON pull_request_monitor_ownership_events(monitor_id, created_at DESC)
  `;
});
