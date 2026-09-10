import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Replace the original pending-only cleanup ledger with a durable intent
 * state machine and a separate canonical-path removal reservation.
 *
 * Legacy pending rows cannot prove their source or PR history, so they are
 * retained as needs-attention rather than being reactivated for deletion.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS worktree_cleanup_jobs (
      thread_id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `;

  const legacyColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(worktree_cleanup_jobs)
  `;
  const columnNames = new Set(legacyColumns.map(({ name }) => name));
  if (!columnNames.has("attempt_count")) {
    yield* sql`
      ALTER TABLE worktree_cleanup_jobs
      ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!columnNames.has("last_error")) {
    yield* sql`
      ALTER TABLE worktree_cleanup_jobs
      ADD COLUMN last_error TEXT
    `;
  }

  yield* sql`DROP TABLE IF EXISTS worktree_cleanup_jobs_v85`;
  yield* sql`
    CREATE TABLE worktree_cleanup_jobs_v85 (
      thread_id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      canonical_worktree_path TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      source TEXT NOT NULL
        CHECK (source IN ('archive', 'delete', 'legacy')),
      status TEXT NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'removing', 'needs-attention', 'completed', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_reason TEXT,
      last_error TEXT
    )
  `;

  yield* sql`
    INSERT INTO worktree_cleanup_jobs_v85 (
      thread_id,
      cwd,
      worktree_path,
      canonical_worktree_path,
      requested_at,
      source,
      status,
      attempt_count,
      next_attempt_at,
      last_reason,
      last_error
    )
    SELECT
      thread_id,
      cwd,
      worktree_path,
      worktree_path,
      requested_at,
      'legacy',
      CASE
        WHEN status = 'cancelled' THEN 'cancelled'
        ELSE 'needs-attention'
      END,
      attempt_count,
      NULL,
      CASE
        WHEN status = 'cancelled' THEN 'cancelled-before-reconciliation'
        ELSE 'legacy-cleanup-intent-requires-review'
      END,
      last_error
    FROM worktree_cleanup_jobs
  `;

  yield* sql`DROP TABLE worktree_cleanup_jobs`;
  yield* sql`ALTER TABLE worktree_cleanup_jobs_v85 RENAME TO worktree_cleanup_jobs`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_worktree_cleanup_jobs_due
    ON worktree_cleanup_jobs(status, next_attempt_at, requested_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS worktree_cleanup_reservations (
      canonical_worktree_path TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL UNIQUE,
      reserved_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES worktree_cleanup_jobs(thread_id) ON DELETE CASCADE
    )
  `;
});
