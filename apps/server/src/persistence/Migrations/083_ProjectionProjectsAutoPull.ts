import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      default_model_selection_json TEXT,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
  if (!columns.some((column) => column.name === "auto_pull")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN auto_pull INTEGER NOT NULL DEFAULT 0`;
  }
});
