import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Ownership and review-handoff metadata for PR monitors.
 * One modifying owner at a time; review threads are linked, not concurrent owners.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE pull_request_monitors
    ADD COLUMN linked_review_thread_id TEXT
  `.pipe(Effect.catch(() => Effect.void));

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
