import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { QueuedTurnReactor } from "../Services/QueuedTurnReactor.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { ThreadTitleReactor } from "../Services/ThreadTitleReactor.ts";
import { TurnLifecycleRuntime } from "../Services/TurnLifecycleRuntime.ts";
import { WorkflowCoordinatorReactor } from "../Services/WorkflowCoordinatorReactor.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";

describe("OrchestrationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("starts turn lifecycle, workflow, and thread deletion reactors", async () => {
    const started: string[] = [];

    runtime = ManagedRuntime.make(
      Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
        Layer.provideMerge(
          Layer.succeed(TurnLifecycleRuntime, {
            start: () => {
              started.push("turn-lifecycle");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadTitleReactor, {
            start: () => {
              started.push("thread-title-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadDeletionReactor, {
            start: () => {
              started.push("thread-deletion-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(QueuedTurnReactor, {
            start: () => {
              started.push("queued-turn-reactor");
              return Effect.void;
            },
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(WorkflowCoordinatorReactor, {
            start: () => {
              started.push("workflow-coordinator-reactor");
              return Effect.void;
            },
            drain: Effect.void,
            drainRun: () => Effect.void,
          }),
        ),
      ),
    );

    const reactor = await runtime!.runPromise(Effect.service(OrchestrationReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    expect(started).toEqual([
      "turn-lifecycle",
      "thread-title-reactor",
      "queued-turn-reactor",
      "workflow-coordinator-reactor",
      "thread-deletion-reactor",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
