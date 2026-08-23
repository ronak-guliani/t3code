import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface TurnLifecycleRuntimeShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class TurnLifecycleRuntime extends Context.Service<
  TurnLifecycleRuntime,
  TurnLifecycleRuntimeShape
>()("t3/orchestration/Services/TurnLifecycleRuntime") {}
