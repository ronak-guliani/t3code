/**
 * CheckpointReactor - Checkpoint reaction service interface.
 *
 * Owns background workers that react to orchestration checkpoint lifecycle
 * events and apply checkpoint side effects.
 *
 * @internal TurnLifecycleRuntime owns completion ordering at this implementation seam.
 *
 * @module CheckpointReactor
 */
import { Context } from "effect";
import type { Effect, Scope } from "effect";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";

/**
 * CheckpointReactorShape - Service API for checkpoint reactor lifecycle.
 */
export interface CheckpointReactorShape {
  /**
   * Start the checkpoint reactor.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Subscribes to orchestration-domain events. Provider-runtime events enter
   * the same internal queue through the ingestion-owned handoff.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Accept a runtime event after ingestion. The queue exists before start,
   * so lifecycle startup cannot lose the handoff to a hot subscription.
   */
  readonly enqueueRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * CheckpointReactor - Service tag for checkpoint reactor workers.
 */
export class CheckpointReactor extends Context.Service<CheckpointReactor, CheckpointReactorShape>()(
  "t3/orchestration/Services/CheckpointReactor",
) {}
