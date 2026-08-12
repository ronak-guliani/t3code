import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable observe-only PR monitors. One active row per canonical
 * (provider, host, repository, number). Snapshots and leases live beside the
 * registration so polling survives process restarts without UI ownership.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_monitors (
      monitor_id TEXT PRIMARY KEY,
      canonical_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      owner_thread_id TEXT,
      status TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      readiness_json TEXT,
      head_sha TEXT,
      source_revision TEXT,
      cursor_json TEXT,
      last_polled_at TEXT,
      next_poll_at TEXT,
      last_error TEXT,
      poll_failure_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      stopped_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pull_request_monitors_due
    ON pull_request_monitors(enabled, next_poll_at)
    WHERE enabled = 1 AND next_poll_at IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pull_request_monitors_project
    ON pull_request_monitors(project_id, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_monitor_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      readiness_json TEXT NOT NULL,
      events_json TEXT NOT NULL,
      FOREIGN KEY (monitor_id) REFERENCES pull_request_monitors(monitor_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pull_request_monitor_snapshots_monitor
    ON pull_request_monitor_snapshots(monitor_id, fetched_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_monitor_leases (
      canonical_key TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_monitor_host_cooldowns (
      host_key TEXT PRIMARY KEY,
      cooldown_until TEXT NOT NULL,
      reason TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
