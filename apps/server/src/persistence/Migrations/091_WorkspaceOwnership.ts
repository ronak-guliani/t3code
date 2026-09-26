import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_ownership (
      canonical_path TEXT PRIMARY KEY,
      worktree_path TEXT NOT NULL,
      owner_thread_id TEXT NOT NULL,
      branch TEXT,
      generation INTEGER NOT NULL,
      command_id TEXT,
      claimed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workspace_ownership_owner
    ON workspace_ownership(owner_thread_id)
  `;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some(({ name }) => name === "workspace_binding_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN workspace_binding_json TEXT`;
  }
});
