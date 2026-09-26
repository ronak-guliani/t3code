import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { PersistenceLayerLive } from "../../server.ts";
import { CollaborativeAcceptanceRepository } from "../Services/CollaborativeAcceptance.ts";

it.effect("builds the packaged persistence layer with Collaborative Acceptance", () =>
  Effect.scoped(
    Layer.build(
      PersistenceLayerLive.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-acceptance-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ).pipe(
      Effect.map((context) => {
        assert.isTrue(
          Context.getOption(context, CollaborativeAcceptanceRepository)._tag === "Some",
        );
      }),
      Effect.asVoid,
    ),
  ),
);
