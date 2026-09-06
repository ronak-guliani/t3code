import { Effect, Layer } from "effect";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { QueuedTurnReactor } from "../Services/QueuedTurnReactor.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { ThreadTitleReactor } from "../Services/ThreadTitleReactor.ts";
import { TurnLifecycleRuntime } from "../Services/TurnLifecycleRuntime.ts";
import { WorkflowCoordinatorReactor } from "../Services/WorkflowCoordinatorReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const turnLifecycle = yield* TurnLifecycleRuntime;
  const queuedTurnReactor = yield* QueuedTurnReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const threadTitleReactor = yield* ThreadTitleReactor;
  const workflowCoordinatorReactor = yield* WorkflowCoordinatorReactor;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* turnLifecycle.start();
    yield* threadTitleReactor.start();
    yield* queuedTurnReactor.start();
    yield* workflowCoordinatorReactor.start();
    yield* threadDeletionReactor.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
