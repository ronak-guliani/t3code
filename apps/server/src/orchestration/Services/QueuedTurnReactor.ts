import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface QueuedTurnReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Wake one recipient after a durable queue mutation; never bypasses queue admission. */
  readonly wakeThread?: (threadId: string) => Effect.Effect<void>;
}

export class QueuedTurnReactor extends Context.Service<QueuedTurnReactor, QueuedTurnReactorShape>()(
  "t3/orchestration/Services/QueuedTurnReactor",
) {}
