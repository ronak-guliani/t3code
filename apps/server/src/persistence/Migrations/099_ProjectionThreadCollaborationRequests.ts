import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionCore from "./005_Projections.ts";
import RepairProjectionCore from "./063_RepairSkippedProjectionCoreSchema.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Divergent ledgers may have advanced past the projection migrations without
  // creating projection_threads. Repair the prerequisite table before ALTER.
  yield* ProjectionCore;
  yield* RepairProjectionCore;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (columns.some(({ name }) => name === "collaboration_requests_json")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN collaboration_requests_json TEXT NOT NULL DEFAULT '[]'
  `;
});
