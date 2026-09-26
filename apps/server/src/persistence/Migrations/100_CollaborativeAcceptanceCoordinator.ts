import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import CollaborativeAcceptance from "./097_CollaborativeAcceptance.ts";

const addColumnIfMissing = (columns: ReadonlyArray<{ readonly name: string }>, name: string) =>
  !columns.some((column) => column.name === name);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* CollaborativeAcceptance;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(collaborative_acceptance_exchanges)
  `;
  if (addColumnIfMissing(columns, "candidate_id")) {
    yield* sql`
      ALTER TABLE collaborative_acceptance_exchanges
      ADD COLUMN candidate_id TEXT
    `;
  }
  if (addColumnIfMissing(columns, "head_sha")) {
    yield* sql`
      ALTER TABLE collaborative_acceptance_exchanges
      ADD COLUMN head_sha TEXT
    `;
  }
  if (addColumnIfMissing(columns, "request_id")) {
    yield* sql`
      ALTER TABLE collaborative_acceptance_exchanges
      ADD COLUMN request_id TEXT
    `;
  }
  if (addColumnIfMissing(columns, "review_mode")) {
    yield* sql`
      ALTER TABLE collaborative_acceptance_exchanges
      ADD COLUMN review_mode TEXT
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_collaborative_acceptance_exchanges_candidate
    ON collaborative_acceptance_exchanges(case_id, candidate_id, head_sha, status)
  `;
});
