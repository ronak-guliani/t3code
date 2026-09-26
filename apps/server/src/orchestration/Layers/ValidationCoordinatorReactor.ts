import { Duration, Effect, Layer, Stream } from "effect";

import {
  ValidationCoordinatorReactor,
  type ValidationCoordinatorReactorShape,
} from "../Services/ValidationCoordinatorReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  isValidationEvent,
  ValidationLifecycle,
  VALIDATION_LEASE_SWEEP_INTERVAL_MS,
} from "../../validation/ValidationLifecycle.ts";

const makeValidationCoordinatorReactor = Effect.gen(function* () {
  const lifecycle = yield* ValidationLifecycle;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const sweepLeaseExpiries = Effect.fn("ValidationCoordinatorReactor.sweepLeaseExpiries")(
    function* () {
      while (true) {
        const delayMs = yield* lifecycle.nextLeaseSweepDelay(VALIDATION_LEASE_SWEEP_INTERVAL_MS);
        if (delayMs > 0) {
          yield* Effect.sleep(Duration.millis(delayMs));
        }
        yield* lifecycle.reconcileAll();
      }
    },
  );

  const start: ValidationCoordinatorReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        isValidationEvent(event) ? lifecycle.reconcileAll() : Effect.void,
      ),
    );
    yield* Effect.forkScoped(sweepLeaseExpiries());
    yield* lifecycle.reconcileAll();
  });

  return {
    request: lifecycle.request,
    reconcile: lifecycle.reconcile,
    start,
  } satisfies ValidationCoordinatorReactorShape;
});

export const ValidationCoordinatorReactorLive = Layer.effect(
  ValidationCoordinatorReactor,
  makeValidationCoordinatorReactor,
);
