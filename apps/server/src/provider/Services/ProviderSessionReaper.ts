import { Context } from "effect";
import type { Effect, Scope } from "effect";

/** @internal TurnLifecycleRuntime owns provider-session reconciliation. */
export interface ProviderSessionReaperShape {
  /**
   * Reconcile provider state left by the previous server process.
   */
  readonly reconcileStartup: Effect.Effect<void>;

  /**
   * Start the background provider session reaper within the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ProviderSessionReaper extends Context.Service<
  ProviderSessionReaper,
  ProviderSessionReaperShape
>()("t3/provider/Services/ProviderSessionReaper") {}
