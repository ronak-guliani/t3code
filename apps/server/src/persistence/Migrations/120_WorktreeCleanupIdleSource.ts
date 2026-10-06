import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Add idle as a cleanup source without dropping a durable in-flight reservation. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE worktree_cleanup_reservations_v113 AS
    SELECT canonical_worktree_path, thread_id, reserved_at
    FROM worktree_cleanup_reservations
  `;
  yield* sql`DROP TABLE worktree_cleanup_reservations`;
  yield* sql`
    CREATE TABLE worktree_cleanup_jobs_v113 (
      thread_id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      canonical_worktree_path TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('archive', 'delete', 'idle', 'legacy')),
      status TEXT NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'removing', 'needs-attention', 'completed', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_reason TEXT,
      last_error TEXT
    )
  `;
  yield* sql`
    INSERT INTO worktree_cleanup_jobs_v113 (
      thread_id, cwd, worktree_path, canonical_worktree_path, requested_at,
      source, status, attempt_count, next_attempt_at, last_reason, last_error
    )
    SELECT
      thread_id, cwd, worktree_path, canonical_worktree_path, requested_at,
      source, status, attempt_count, next_attempt_at, last_reason, last_error
    FROM worktree_cleanup_jobs
  `;
  yield* sql`DROP TABLE worktree_cleanup_jobs`;
  yield* sql`ALTER TABLE worktree_cleanup_jobs_v113 RENAME TO worktree_cleanup_jobs`;
  yield* sql`
    CREATE INDEX idx_worktree_cleanup_jobs_due
    ON worktree_cleanup_jobs(next_attempt_at, requested_at, thread_id)
    WHERE status = 'waiting'
  `;
  yield* sql`
    CREATE TABLE worktree_cleanup_reservations (
      canonical_worktree_path TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL UNIQUE,
      reserved_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES worktree_cleanup_jobs(thread_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    INSERT INTO worktree_cleanup_reservations (
      canonical_worktree_path, thread_id, reserved_at
    )
    SELECT canonical_worktree_path, thread_id, reserved_at
    FROM worktree_cleanup_reservations_v113
  `;
  yield* sql`DROP TABLE worktree_cleanup_reservations_v113`;
});
