import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionCore from "./005_Projections.ts";
import RepairProjectionCore from "./063_RepairSkippedProjectionCoreSchema.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Divergent ledgers can skip the original projection migration entirely.
  // Re-run its guarded creation/repair steps before adding the new column.
  yield* ProjectionCore;
  yield* RepairProjectionCore;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (columns.some(({ name }) => name === "validation_run_json")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN validation_run_json TEXT
  `;
});
