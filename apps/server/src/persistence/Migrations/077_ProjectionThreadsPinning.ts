import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has("pinned_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN pinned_at TEXT`;
  }
  if (!names.has("pin_order_key")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN pin_order_key TEXT`;
  }
});
