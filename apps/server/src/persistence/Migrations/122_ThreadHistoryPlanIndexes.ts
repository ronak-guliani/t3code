import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import ensurePlans from "./013_ProjectionThreadProposedPlans.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensurePlans;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_thread_plans_turn ON projection_thread_proposed_plans(thread_id,turn_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_thread_plans_latest ON projection_thread_proposed_plans(thread_id,updated_at DESC,plan_id DESC)`;
});
