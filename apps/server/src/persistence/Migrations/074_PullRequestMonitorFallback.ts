import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable ledger for PR monitor fallback maintenance launches.
 * Prevents thrashing and records exclusive ownership handoffs to fallback threads.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_monitor_fallback_launches (
      launch_id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      thread_id TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (monitor_id) REFERENCES pull_request_monitors(monitor_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_monitor_fallback_monitor_created
    ON pull_request_monitor_fallback_launches(monitor_id, created_at DESC)
  `;
});
