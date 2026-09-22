import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_collaborative_acceptance_cases_parent_thread
    ON collaborative_acceptance_cases(parent_thread_id, updated_at DESC)
  `;
});
