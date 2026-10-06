import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_worktree_cleanup_jobs_due
    ON worktree_cleanup_jobs(next_attempt_at, requested_at, thread_id)
    WHERE status = 'waiting'
  `;
});
