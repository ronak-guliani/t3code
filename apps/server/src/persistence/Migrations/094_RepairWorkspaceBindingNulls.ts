import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 091 added `projection_threads.workspace_binding_json` as nullable
 * TEXT with no default, so pre-existing rows carry SQL NULL. The projection
 * readers expect a JSON string (`'null'` for empty), and SQL NULL fails
 * decoding with `Expected string, got null` at `["workspaceBinding"]`.
 *
 * Backfill NULLs to the JSON null string so `getById` (review workflow and
 * elsewhere) decodes existing rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some(({ name }) => name === "workspace_binding_json")) {
    return;
  }

  yield* sql`
    UPDATE projection_threads
    SET workspace_binding_json = 'null'
    WHERE workspace_binding_json IS NULL
  `;
});
