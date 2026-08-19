import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0077 from "./077_ProjectionThreadsPinning.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Migration0077;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "title_regeneration_request_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_regeneration_request_id TEXT
    `;
  }

  if (!columns.some((column) => column.name === "title_regeneration_started_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_regeneration_started_at TEXT
    `;
  }
});
