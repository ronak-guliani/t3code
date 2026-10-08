import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Hard delete purges the thread's rows and event stream, so after a restart the
 * cleanup job can no longer read the branch it must verify from the thread. Pin
 * the expected branch onto the job at consent time. Nullable: rows written
 * before this migration have no expectation and fall back to the thread.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(worktree_cleanup_jobs)
  `;
  if (!columns.some(({ name }) => name === "expected_branch")) {
    yield* sql`
      ALTER TABLE worktree_cleanup_jobs
      ADD COLUMN expected_branch TEXT
    `;
  }
  yield* sql`
    UPDATE worktree_cleanup_jobs
    SET expected_branch = (
      SELECT branch FROM projection_threads
      WHERE projection_threads.thread_id = worktree_cleanup_jobs.thread_id
    )
    WHERE expected_branch IS NULL
  `;
});
