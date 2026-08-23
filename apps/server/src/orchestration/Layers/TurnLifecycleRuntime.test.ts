import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
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
    runtime = ManagedRuntime.make(
      TurnLifecycleRuntimeLive.pipe(
        Layer.provideMerge(
          Layer.succeed(ProviderSessionReaper, {
            reconcileStartup: Effect.sync(() => calls.push("reconcile")),
            start: () => Effect.sync(() => calls.push("reaper")),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderRuntimeIngestionService, {
            start: () => Effect.sync(() => calls.push("ingestion")),
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
            drain: Effect.sync(() => calls.push("drain-checkpoints")),
          }),
        ),
      ),
    );

    const lifecycle = await runtime.runPromise(Effect.service(TurnLifecycleRuntime));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(lifecycle.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(lifecycle.drain);

    expect(calls).toEqual([
      "reconcile",
      "ingestion",
      "commands",
      "checkpoints",
      "reaper",
      "drain-commands",
      "drain-ingestion",
      "drain-checkpoints",
      "drain-commands",
    ]);
  });
});
