import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { QueuedTurnReactor } from "../Services/QueuedTurnReactor.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { ThreadTitleReactor } from "../Services/ThreadTitleReactor.ts";
import { TurnLifecycleRuntime } from "../Services/TurnLifecycleRuntime.ts";
import { WorkflowCoordinatorReactor } from "../Services/WorkflowCoordinatorReactor.ts";
import { ValidationCoordinatorReactor } from "../Services/ValidationCoordinatorReactor.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { isValidationCoordinatorOwnedRun } from "./ValidationCoordinatorReactor.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";
import { planValidationCoordinatorRun, planValidationRun } from "@t3tools/contracts";

describe("OrchestrationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("only treats request-bound runs as coordinator-owned", () => {
    const target = {
      workspaceRoot: "/workspace",
      worktreePath: "/workspace/.worktree",
      branch: "main",
      revision: "revision-1",
      dirtyStateFingerprint: "dirty-1",
      environmentIdentity: "environment-1",
    };

    expect(
      isValidationCoordinatorOwnedRun(
        planValidationRun({
          id: "legacy-run",
          threadId: "thread-1" as never,
          target,
          requestedAt: "2026-09-18T00:00:00.000Z",
        }),
      ),
    ).toBe(false);
    expect(
      isValidationCoordinatorOwnedRun(
        planValidationCoordinatorRun({
          id: "coordinator-run",
          requestId: "request-1",
          threadId: "thread-1" as never,
          target,
          scenarios: [],
          scope: "changed-behavior",
          requester: { id: "system", kind: "system" },
          requestedAt: "2026-09-18T00:00:00.000Z",
        }),
      ),
    ).toBe(true);
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
        Layer.provideMerge(
          Layer.succeed(ValidationCoordinatorReactor, {
            request: () => Effect.succeed({ runId: "run-1" }),
            reconcile: () => Effect.void,
            start: () => {
              started.push("validation-coordinator-reactor");
              return Effect.void;
            },
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
      "validation-coordinator-reactor",
      "thread-deletion-reactor",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
