import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionThreadSessionResumeCursor from "./026_ProjectionThreadSessionResumeCursor.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ProjectionThreadSessionResumeCursor;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (columns.some((column) => column.name === "active_message_id")) {
    return;
  }
  yield* sql`
    ALTER TABLE projection_thread_sessions
    ADD COLUMN active_message_id TEXT
  `;
});
