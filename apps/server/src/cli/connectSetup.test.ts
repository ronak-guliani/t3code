import { assert, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Exit } from "effect";
import { hostSetupLocation, runConnectSetup, setupStage } from "./connectSetup.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDefaultLocalBaseDir } from "@t3tools/shared/localEnvironment";

it("offers an existing non-legacy host before strict default resolution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-setup-discovery-"));
  const home = await realpath(directory);
  try {
    const baseDir = join(home, ".t3-rg");
    await mkdir(join(baseDir, "userdata"), { recursive: true });
    await writeFile(join(baseDir, "userdata", "environment-id"), "existing-environment");
    await expect(resolveDefaultLocalBaseDir(home)).rejects.toThrow("existing local environment");
    const location = await Effect.runPromise(
      hostSetupLocation(undefined, home).pipe(Effect.provide(NodeServices.layer)),
    );
    assert.equal(location.kind, "choose");
    if (location.kind === "choose")
      assert.includeMembers(
        location.choices.map((choice) => choice.value),
        [baseDir, join(home, ".t3")],
      );
    const explicit = await Effect.runPromise(
      hostSetupLocation(baseDir, home).pipe(Effect.provide(NodeServices.layer)),
    );
    assert.deepEqual(explicit, { kind: "explicit", baseDir });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
