import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(workspace_ownership)`;
  if (!columns.some(({ name }) => name === "attempt_id")) {
    yield* sql`ALTER TABLE workspace_ownership ADD COLUMN attempt_id TEXT`;
  }
});
