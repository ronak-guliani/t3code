import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_turn_history
    ON projection_thread_messages(thread_id, turn_id, sequence, role, message_id)`;
});
