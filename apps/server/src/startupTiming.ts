import { Clock, Effect, Layer } from "effect";

export const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeNanos;
    yield* Effect.logInfo("startup phase started", { phase });
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const endedAt = yield* Clock.currentTimeNanos;
          yield* Effect.logInfo("startup phase finished", {
            phase,
            elapsedMs: Number(endedAt - startedAt) / 1_000_000,
            outcome: exit._tag,
          });
        }),
      ),
    );
  }).pipe(
    Effect.annotateSpans({ "startup.phase": phase }),
    Effect.withSpan(`server.startup.${phase}`),
  );

export const timeStartupLayer = <A, E, R>(phase: string, layer: Layer.Layer<A, E, R>) =>
  Layer.fromBuild((memoMap, scope) =>
    runStartupPhase(phase, Layer.buildWithMemoMap(layer, memoMap, scope)),
  );
