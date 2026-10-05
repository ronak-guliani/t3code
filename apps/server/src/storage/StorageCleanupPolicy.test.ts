import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerSettings } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { Effect, Layer, PubSub, Ref, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  StorageCleanupPolicy,
  StorageCleanupPolicyLayer,
  StorageFreeSpaceProbe,
} from "./StorageCleanupPolicy.ts";

/*
 * Failure modes: low disk loosens or re-enables a disabled window; the switch
 * fails to pause a sweep; re-enabling waits a full interval instead of waking.
 */
const TOTAL = 1000;

function makePolicy(settings: Partial<ServerSettings>, freeBytes: { current: number }) {
  return Effect.gen(function* () {
    const ref = yield* Ref.make<ServerSettings>({ ...DEFAULT_SERVER_SETTINGS, ...settings });
    const changes = yield* PubSub.unbounded<ServerSettings>();
    const settingsLayer = Layer.succeed(ServerSettingsService, {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(ref),
      updateSettings: (patch) =>
        Ref.updateAndGet(ref, (current) => ({ ...current, ...patch }) as ServerSettings).pipe(
          Effect.tap((next) => PubSub.publish(changes, next)),
        ),
      streamChanges: Stream.fromPubSub(changes),
    } as ServerSettingsService["Service"]);
    const context = yield* Layer.build(
      StorageCleanupPolicyLayer.pipe(
        Layer.provideMerge(settingsLayer),
        Layer.provide(
          Layer.succeed(StorageFreeSpaceProbe, {
            probe: async () => ({ freeBytes: freeBytes.current, totalBytes: TOTAL }),
          }),
        ),
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({
            getReadModel: () =>
              Effect.succeed({
                snapshotSequence: 0,
                projects: [],
                threads: [],
                workflowRuns: [],
                updatedAt: "2026-01-01T00:00:00.000Z",
              }),
          }),
        ),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-storage-policy-" })),
        Layer.provide(NodeServices.layer),
      ),
    );
    return {
      policy: Effect.provide(Effect.service(StorageCleanupPolicy), context),
      settings: Effect.provide(Effect.service(ServerSettingsService), context),
    };
  });
}

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

describe("StorageCleanupPolicy", () => {
  it("tightens retention below 10% free but keeps a disabled window off", async () => {
    await run(
      Effect.gen(function* () {
        const free = { current: 500 };
        const handles = yield* makePolicy({ providerLogRetentionDays: 14 }, free);
        const policy = yield* handles.policy;
        expect((yield* policy.current).providerLogRetentionDays).toBe(14);

        free.current = 99; // 9.9% free
        const status = yield* policy.measureLowDisk;
        expect(status).toMatchObject({ active: true, freePercent: 9.9 });
        expect((yield* policy.current).providerLogRetentionDays).toBe(3);

        const settings = yield* handles.settings;
        yield* settings.updateSettings({ providerLogRetentionDays: null });
        expect((yield* policy.current).providerLogRetentionDays).toBeNull();
        yield* settings.updateSettings({ providerLogRetentionDays: 2 });
        expect((yield* policy.current).providerLogRetentionDays).toBe(2);
      }),
    );
  });

  it("pauses automatic sweeps while the switch is off and wakes them when re-enabled", async () => {
    await run(
      Effect.gen(function* () {
        const handles = yield* makePolicy({ automaticCleanupEnabled: false }, { current: 500 });
        const policy = yield* handles.policy;
        let sweeps = 0;
        yield* policy.runAutomatic({
          name: "test",
          initialDelay: 0,
          interval: "1 hour",
          sweep: () => Effect.sync(() => void (sweeps += 1)),
        });
        yield* Effect.sleep("50 millis");
        expect(sweeps).toBe(0);

        yield* (yield* handles.settings).updateSettings({ automaticCleanupEnabled: true });
        yield* Effect.sleep("50 millis");
        expect(sweeps).toBe(1);
      }),
    );
  });
});
