import { Effect, Stream } from "effect";
import { expect, it } from "vitest";
import { withRpcDeadlines } from "./rpcDeadline.ts";

it("bounds each unary call without retrying mutations", async () => {
  let attempts = 0;
  const client = withRpcDeadlines(
    {
      mutate: () =>
        Effect.sync(() => {
          attempts++;
        }).pipe(Effect.andThen(Effect.never)),
    },
    "10 millis",
  );
  const result = await Effect.runPromise(Effect.result(client.mutate()));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(String(result.failure)).toContain("CLI_RPC_TIMEOUT");
  expect(attempts).toBe(1);
});

it("does not impose a total lifetime on streams or a multi-call session", async () => {
  const stream = Stream.fromEffect(Effect.sleep("30 millis").pipe(Effect.as("event")));
  const client = withRpcDeadlines(
    { watch: () => stream, read: () => Effect.succeed("ok") },
    "10 millis",
  );
  expect(client.watch()).toBe(stream);
  expect(await Effect.runPromise(Stream.runCollect(client.watch()))).toEqual(["event"]);
  expect(await Effect.runPromise(client.read())).toBe("ok");
});
