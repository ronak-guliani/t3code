import { Effect, Layer } from "effect";

import { ProviderSessionReaperLive } from "../../provider/Layers/ProviderSessionReaper.ts";
import { ProviderSessionReaper } from "../../provider/Services/ProviderSessionReaper.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import {
  TurnLifecycleRuntime,
  type TurnLifecycleRuntimeShape,
} from "../Services/TurnLifecycleRuntime.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { ProviderCommandReactorLive } from "./ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";

export const makeTurnLifecycleRuntime = Effect.gen(function* () {
  const sessionReaper = yield* ProviderSessionReaper;
  const runtimeIngestion = yield* ProviderRuntimeIngestionService;
  const commandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;

  const start: TurnLifecycleRuntimeShape["start"] = Effect.fn("start")(function* () {
    yield* sessionReaper.reconcileStartup;
    yield* runtimeIngestion.start();
    yield* commandReactor.start();
    yield* checkpointReactor.start();
    yield* sessionReaper.start();
  });

  const drain: TurnLifecycleRuntimeShape["drain"] = Effect.gen(function* () {
    yield* commandReactor.drain;
    yield* runtimeIngestion.drain;
    yield* checkpointReactor.drain;
    // Runtime ingestion and checkpoint finalization can append domain events.
    yield* commandReactor.drain;
  });

  return { start, drain } satisfies TurnLifecycleRuntimeShape;
});

export const TurnLifecycleRuntimeLive = Layer.effect(
  TurnLifecycleRuntime,
  makeTurnLifecycleRuntime,
);

const TurnLifecycleWorkersLive = Layer.mergeAll(
  ProviderRuntimeIngestionLive,
  ProviderCommandReactorLive,
  CheckpointReactorLive.pipe(Layer.provide(ProviderRuntimeIngestionLive)),
  ProviderSessionReaperLive,
);

export const TurnLifecycleRuntimeLayerLive = TurnLifecycleRuntimeLive.pipe(
  Layer.provide(TurnLifecycleWorkersLive),
);
