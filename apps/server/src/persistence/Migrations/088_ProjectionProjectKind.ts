import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_projects (
      project_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'workspace',
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      auto_pull INTEGER NOT NULL DEFAULT 0,
      default_model_selection_json TEXT,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
  if (!columns.some((column) => column.name === "kind")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN kind TEXT NOT NULL DEFAULT 'workspace'
    `;
  }
});
