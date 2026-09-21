import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const hasColumn = (columns: ReadonlyArray<{ readonly name: string }>, name: string): boolean =>
  columns.some((column) => column.name === name);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(collaborative_acceptance_cases)
  `;

  if (!hasColumn(columns, "provider_evidence_json")) {
    yield* sql`
      ALTER TABLE collaborative_acceptance_cases
      ADD COLUMN provider_evidence_json TEXT
    `;
  }
  if (!hasColumn(columns, "obligations_json")) {
    yield* sql`
      ALTER TABLE collaborative_acceptance_cases
      ADD COLUMN obligations_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
