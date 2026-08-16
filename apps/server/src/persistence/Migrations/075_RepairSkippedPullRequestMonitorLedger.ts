import * as Effect from "effect/Effect";

import ProjectionThreadSessionActiveMessage from "./069_ProjectionThreadSessionActiveMessage.ts";
import RepairSkippedRoleAuthTables from "./070_RepairSkippedRoleAuthTables.ts";

/**
 * Ledgers that ran the pre-release PR monitor migrations at IDs 069-072 advanced
 * past the IDs main later published, so 069/070 would be skipped forever. Both
 * are idempotent, so replay them above the renumbered monitor migrations.
 */
export default Effect.gen(function* () {
  yield* ProjectionThreadSessionActiveMessage;
  yield* RepairSkippedRoleAuthTables;
});
