import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { runConnectSetup, setupStage } from "./connectSetup.ts";

it.effect("client setup never evaluates host initialization", () =>
  Effect.gen(function* () {
    let clients = 0;
    yield* runConnectSetup({
      role: "client",
      client: Effect.sync(() => {
        clients += 1;
      }),
      host: Effect.die("must not create a host"),
    });
    assert.equal(clients, 1);
  }),
);

it.effect("host setup never evaluates the client branch", () =>
  runConnectSetup({
    role: "host",
    client: Effect.die("unexpected client"),
    host: Effect.void,
  }),
);

it.effect("a failed stage keeps its cause and identifies the resumable boundary", () =>
  Effect.gen(function* () {
    const cause = new Error("service stopped");
    const result = yield* setupStage("server", Effect.fail(cause)).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(result));
    const error = yield* setupStage("server", Effect.fail(cause)).pipe(Effect.flip);
    assert.include(error.message, "'server'");
    assert.include(error.message, "--base-dir");
    assert.equal(error.cause, cause);
  }),
);
