import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_user_history
    ON projection_thread_messages(thread_id, role, sequence)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_turns_pending_message_history
    ON projection_turns(thread_id, pending_message_id)`;
});
