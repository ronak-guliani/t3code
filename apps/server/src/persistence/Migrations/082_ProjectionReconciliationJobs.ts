import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_reconciliation_jobs (
      sequence INTEGER PRIMARY KEY,
      shell_thread_ids_json TEXT NOT NULL,
      attachment_thread_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
