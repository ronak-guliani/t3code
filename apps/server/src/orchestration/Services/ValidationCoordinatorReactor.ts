import type {
  ThreadId,
  ValidationRequester,
  ValidationRun,
  ValidationScenario,
  ValidationScope,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface ValidationCoordinatorRequest {
  readonly threadId: ThreadId;
  readonly scenarios: ReadonlyArray<ValidationScenario>;
  readonly scope: ValidationScope;
  readonly requester: ValidationRequester;
}

export interface ValidationCoordinatorTargetResolverShape {
  readonly resolve: (
    threadId: ThreadId,
  ) => Effect.Effect<import("@t3tools/contracts").ValidationTarget, Error>;
}

export class ValidationCoordinatorTargetResolver extends Context.Service<
  ValidationCoordinatorTargetResolver,
  ValidationCoordinatorTargetResolverShape
>()("t3/orchestration/Services/ValidationCoordinatorTargetResolver") {}

export interface ValidationCoordinatorReactorShape {
  readonly request: (
    input: ValidationCoordinatorRequest,
  ) => Effect.Effect<{ readonly runId: string }, Error>;
  readonly reconcile: (runId: string) => Effect.Effect<void, never>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ValidationCoordinatorReactor extends Context.Service<
  ValidationCoordinatorReactor,
  ValidationCoordinatorReactorShape
>()("t3/orchestration/Services/ValidationCoordinatorReactor") {}

export type ValidationCoordinatorRun = ValidationRun;
