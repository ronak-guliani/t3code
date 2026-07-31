import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE worktree_cleanup_jobs
    ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
  `;

  yield* sql`
    ALTER TABLE worktree_cleanup_jobs
    ADD COLUMN last_error TEXT
  `;
});
