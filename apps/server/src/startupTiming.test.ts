import { assert, it } from "@effect/vitest";
import { Context, Effect, Layer, Logger } from "effect";
import { TestClock } from "effect/testing";

import { runStartupPhase, timeStartupLayer } from "./startupTiming.ts";

it.effect("records elapsed startup time without changing the result", () =>
  Effect.gen(function* () {
    const messages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    const result = yield* runStartupPhase(
      "test.success",
      TestClock.adjust("125 millis").pipe(Effect.as("ready")),
    ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

    assert.equal(result, "ready");
    assert.deepStrictEqual(messages, [
      ["startup phase started", { phase: "test.success" }],
      ["startup phase finished", { phase: "test.success", elapsedMs: 125, outcome: "Success" }],
    ]);
  }),
);

it.effect("reports a failed phase while preserving the original failure", () =>
  Effect.gen(function* () {
    const messages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    const failure = new Error("startup failed");
    const result = yield* runStartupPhase("test.failure", Effect.fail(failure)).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.flip,
    );

    assert.strictEqual(result, failure);
    assert.deepStrictEqual(messages.at(-1), [
      "startup phase finished",
      { phase: "test.failure", elapsedMs: 0, outcome: "Failure" },
    ]);
  }),
);

it.effect("preserves shared layer memoization and scoped release", () =>
  Effect.gen(function* () {
    class Resource extends Context.Service<Resource, object>()("test/StartupResource") {}
    let acquired = 0;
    let released = 0;
    const resource = Layer.effect(
      Resource,
      Effect.acquireRelease(
        Effect.sync(() => {
          acquired++;
          return {};
        }),
        () =>
          Effect.sync(() => {
            released++;
          }),
      ),
    );
    yield* Effect.scoped(
      Layer.build(
        Layer.mergeAll(
          resource,
          timeStartupLayer("test.layer.first", resource),
          timeStartupLayer("test.layer.second", resource),
        ),
      ),
    );
    assert.equal(acquired, 1);
    assert.equal(released, 1);
  }),
);
