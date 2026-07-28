import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionThreadMessageSearch from "./048_ProjectionThreadMessageSearch.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existingTable = yield* sql<{ readonly count: number }>`
    SELECT count(*) AS count
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_thread_message_fts'
  `;

  if ((existingTable[0]?.count ?? 0) > 0) {
    return;
  }

  yield* ProjectionThreadMessageSearch;
});
