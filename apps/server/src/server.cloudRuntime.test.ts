import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { ServerConfig } from "./config.ts";
import { CloudRuntimeLayerLive, makeServerLayer } from "./server.ts";

const FullRuntimeTestConfig = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return {
      ...config,
      mode: "desktop" as const,
      host: "127.0.0.1",
      noBrowser: true,
      startupPresentation: "service" as const,
    };
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-full-runtime-test-" })));

it.effect("builds the cloud runtime with all eager startup dependencies", () =>
  Effect.scoped(
    Layer.build(
      CloudRuntimeLayerLive.pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-cloud-runtime-test-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ).pipe(Effect.asVoid),
  ),
);

it.effect("builds the full server runtime with all eager startup dependencies", () =>
  Effect.scoped(
    Layer.build(
      makeServerLayer.pipe(
        Layer.provideMerge(FullRuntimeTestConfig),
        Layer.provideMerge(NodeServices.layer),
      ),
    ).pipe(Effect.asVoid),
  ),
);
