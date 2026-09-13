import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeEnsureRemoteSetupHost } from "./remote.ts";

it.effect("reuses a live foreground or desktop owner without service mutation", () =>
  Effect.gen(function* () {
    for (const owner of ["foreground", "desktop"] as const) {
      let serviceCalls = 0;
      const ensureRemoteSetupHost = makeEnsureRemoteSetupHost({
        inspectRuntimeOwnership: async () => ({ state: "running", owner, pid: 4321 }),
        ensureBackgroundServiceForBaseDir: () =>
          Effect.sync(() => {
            serviceCalls += 1;
            return "ready" as const;
          }),
      });

      yield* ensureRemoteSetupHost("/data");
      assert.equal(serviceCalls, 0);
    }
  }),
);

it.effect("recovers the background service when no runtime owner is running", () =>
  Effect.gen(function* () {
    const calls: Array<{
      readonly baseDir: string;
      readonly restartRequired: boolean | undefined;
    }> = [];
    const ensureRemoteSetupHost = makeEnsureRemoteSetupHost({
      inspectRuntimeOwnership: async () => ({ state: "stopped", owner: "none", pid: null }),
      ensureBackgroundServiceForBaseDir: (baseDir, input) =>
        Effect.sync(() => {
          calls.push({ baseDir, restartRequired: input?.restartRequired });
          return "installed" as const;
        }),
    });

    yield* ensureRemoteSetupHost("/data");
    assert.deepStrictEqual(calls, [{ baseDir: "/data", restartRequired: true }]);
  }),
);

it.effect("checks a live background owner through the service health path", () =>
  Effect.gen(function* () {
    const calls: Array<{
      readonly baseDir: string;
      readonly restartRequired: boolean | undefined;
    }> = [];
    const ensureRemoteSetupHost = makeEnsureRemoteSetupHost({
      inspectRuntimeOwnership: async () => ({
        state: "running",
        owner: "background",
        pid: 4321,
      }),
      ensureBackgroundServiceForBaseDir: (baseDir, input) =>
        Effect.sync(() => {
          calls.push({ baseDir, restartRequired: input?.restartRequired });
          return "ready" as const;
        }),
    });

    yield* ensureRemoteSetupHost("/data");
    assert.deepStrictEqual(calls, [{ baseDir: "/data", restartRequired: false }]);
  }),
);

it.effect("fails closed on unreadable ownership state without service mutation", () =>
  Effect.gen(function* () {
    let serviceCalls = 0;
    const ensureRemoteSetupHost = makeEnsureRemoteSetupHost({
      inspectRuntimeOwnership: async () => {
        throw new Error("permission denied");
      },
      ensureBackgroundServiceForBaseDir: () =>
        Effect.sync(() => {
          serviceCalls += 1;
          return "ready" as const;
        }),
    });

    const error = yield* Effect.flip(ensureRemoteSetupHost("/data"));
    assert.isTrue("cause" in error);
    if ("cause" in error) {
      assert.equal(
        error.cause instanceof Error ? error.cause.message : undefined,
        "permission denied",
      );
    }
    assert.equal(serviceCalls, 0);
  }),
);
