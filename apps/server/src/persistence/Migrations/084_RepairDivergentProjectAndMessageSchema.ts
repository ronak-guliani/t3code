import * as Effect from "effect/Effect";

import ProjectionProjectsAutoPull from "./083_ProjectionProjectsAutoPull.ts";
import ProjectionThreadMessageSequence from "./083_ProjectionThreadMessageSequence.ts";

// Both branches shipped ID 83. Repair either ledger without changing its history.
export default Effect.gen(function* () {
  yield* ProjectionProjectsAutoPull;
  yield* ProjectionThreadMessageSequence;
});
