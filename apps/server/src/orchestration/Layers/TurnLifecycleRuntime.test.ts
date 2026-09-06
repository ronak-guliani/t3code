import { Deferred, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ProviderSessionReaper } from "../../provider/Services/ProviderSessionReaper.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { TurnLifecycleRuntime } from "../Services/TurnLifecycleRuntime.ts";
import { TurnLifecycleRuntimeLive } from "./TurnLifecycleRuntime.ts";

describe("TurnLifecycleRuntime", () => {
  let runtime: ManagedRuntime.ManagedRuntime<TurnLifecycleRuntime, never> | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    if (runtime) {
      await runtime.dispose();
    }
    scope = null;
    runtime = null;
  });

  it("reconciles sessions before starting ordered lifecycle workers", async () => {
    const calls: string[] = [];
    const reconciling = Effect.runSync(Deferred.make<void>());
    const reconciled = Effect.runSync(Deferred.make<void>());
    const enqueueRuntimeEvent = () => Effect.void;
    runtime = ManagedRuntime.make(
      TurnLifecycleRuntimeLive.pipe(
        Layer.provideMerge(
          Layer.succeed(ProviderSessionReaper, {
            reconcileStartup: Effect.sync(() => calls.push("reconcile")).pipe(
              Effect.andThen(Deferred.succeed(reconciling, undefined)),
              Effect.andThen(Deferred.await(reconciled)),
            ),
            start: () => Effect.sync(() => calls.push("reaper")),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderRuntimeIngestionService, {
            start: (enqueueCheckpointEvent) =>
              Effect.sync(() => {
                expect(enqueueCheckpointEvent).toBe(enqueueRuntimeEvent);
                calls.push("ingestion");
              }),
            drain: Effect.sync(() => calls.push("drain-ingestion")),
            awaitTurnCompletionProcessed: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderCommandReactor, {
            start: () => Effect.sync(() => calls.push("commands")),
            drain: Effect.sync(() => calls.push("drain-commands")),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CheckpointReactor, {
            start: () => Effect.sync(() => calls.push("checkpoints")),
            enqueueRuntimeEvent,
            drain: Effect.sync(() => calls.push("drain-checkpoints")),
          }),
        ),
      ),
    );

    const lifecycle = await runtime.runPromise(Effect.service(TurnLifecycleRuntime));
    scope = await Effect.runPromise(Scope.make("sequential"));
    const starting = Effect.runPromise(lifecycle.start().pipe(Scope.provide(scope)));
    try {
      await Effect.runPromise(Deferred.await(reconciling));
      expect(calls).toEqual(["reconcile"]);
    } finally {
      await Effect.runPromise(Deferred.succeed(reconciled, undefined));
    }
    await starting;
    await runtime.runPromise(lifecycle.drain);

    expect(calls).toEqual([
      "reconcile",
      "checkpoints",
      "ingestion",
      "commands",
      "reaper",
      "drain-commands",
      "drain-ingestion",
      "drain-checkpoints",
      "drain-commands",
    ]);
  });
});
