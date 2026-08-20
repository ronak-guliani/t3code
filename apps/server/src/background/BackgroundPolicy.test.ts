import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  RpcClientId,
  type ClientActivityReportInput,
  type HostPowerSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BackgroundPolicy from "./BackgroundPolicy.ts";
import * as HostPowerMonitor from "./HostPowerMonitor.ts";

const TEST_NOW = DateTime.makeUnsafe("2026-08-20T00:00:00.000Z");

const nominalHostPower: HostPowerSnapshot = {
  source: "unknown",
  idle: "unknown",
  idleSeconds: null,
  locked: "unknown",
  suspended: false,
  onBattery: "unknown",
  lowPowerMode: "unknown",
  thermalState: "unknown",
  stale: true,
  updatedAt: TEST_NOW,
};

function makeReport(overrides: Partial<ClientActivityReportInput> = {}): ClientActivityReportInput {
  return {
    clientId: "mobile-device",
    clientKind: "mobile",
    visible: true,
    focused: true,
    recentlyInteracted: true,
    appState: "active",
    scopes: [{ type: "provider-status" }],
    ttlMs: 45_000,
    observedAt: TEST_NOW,
    ...overrides,
  };
}

function makeLayer(hostPower: HostPowerSnapshot = nominalHostPower) {
  return BackgroundPolicy.layer.pipe(
    Layer.provide(
      Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make(hostPower)),
    ),
  );
}

describe("BackgroundPolicy", () => {
  it.effect("records the official mobile activity lease and removes it on disconnect", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("mobile-session");
      const rpcClientId = RpcClientId.make(1);

      yield* policy.reportClientActivity(sessionId, rpcClientId, makeReport());
      const connected = yield* policy.snapshot;

      assert.equal(connected.activeForegroundLeaseCount, 1);
      assert.deepStrictEqual(connected.activeScopeKeys, ["provider-status"]);
      assert.equal(connected.leases[0]?.clientKind, "mobile");
      assert.equal(connected.shouldRunOpportunisticWork, true);

      yield* policy.removeRpcClient(sessionId, rpcClientId);
      const disconnected = yield* policy.snapshot;

      assert.equal(disconnected.activeForegroundLeaseCount, 0);
      assert.deepStrictEqual(disconnected.activeScopeKeys, []);
      assert.equal(disconnected.shouldRunOpportunisticWork, false);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("keeps a replacement connection when the older connection disconnects", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("mobile-session");
      const oldConnectionId = RpcClientId.make(1);
      const replacementConnectionId = RpcClientId.make(2);

      yield* policy.reportClientActivity(
        sessionId,
        oldConnectionId,
        makeReport({ clientId: "stable-mobile-device" }),
      );
      yield* policy.reportClientActivity(
        sessionId,
        replacementConnectionId,
        makeReport({ clientId: "stable-mobile-device" }),
      );
      yield* policy.removeRpcClient(sessionId, oldConnectionId);

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.leases.length, 1);
      assert.equal(snapshot.leases[0]?.rpcClientId, replacementConnectionId);
      assert.equal(snapshot.leases[0]?.clientId, "stable-mobile-device");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("filters lease metadata and aggregates by authenticated session", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const firstSession = AuthSessionId.make("session-1");
      const secondSession = AuthSessionId.make("session-2");
      yield* policy.reportClientActivity(
        firstSession,
        RpcClientId.make(1),
        makeReport({ clientId: "first-device" }),
      );
      yield* policy.reportClientActivity(
        secondSession,
        RpcClientId.make(2),
        makeReport({
          clientId: "second-device",
          scopes: [{ type: "diagnostics" }],
        }),
      );

      const snapshot = yield* policy.snapshotForSession(firstSession);
      assert.equal(snapshot.leases.length, 1);
      assert.equal(snapshot.leases[0]?.clientId, "first-device");
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.deepStrictEqual(snapshot.activeScopeKeys, ["provider-status"]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("bounds client-id churn on one websocket connection", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("mobile-session");
      const rpcClientId = RpcClientId.make(1);

      for (
        let index = 0;
        index <= BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT;
        index += 1
      ) {
        yield* policy.reportClientActivity(
          sessionId,
          rpcClientId,
          makeReport({ clientId: `mobile-device-${index}` }),
        );
      }

      const snapshot = yield* policy.snapshot;
      assert.equal(
        snapshot.leases.length,
        BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT,
      );
      assert.isTrue(
        snapshot.leases.some(
          (lease) =>
            lease.clientId ===
            `mobile-device-${BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT}`,
        ),
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("honors fresh host constraints without trusting stale power data", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("mobile-session"),
        RpcClientId.make(1),
        makeReport(),
      );

      const constrained = yield* policy.snapshot;
      assert.equal(constrained.shouldRunOpportunisticWork, false);
    }).pipe(
      Effect.provide(
        makeLayer({
          ...nominalHostPower,
          lowPowerMode: "true",
          stale: false,
        }),
      ),
    ),
  );

  it.effect("replaces client-supplied host timestamps with server receipt time", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportHostPowerState({
        ...nominalHostPower,
        source: "electron-main",
        stale: false,
        updatedAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
      });

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.hostPower.source, "electron-main");
      assert.isBelow(
        DateTime.toEpochMillis(snapshot.hostPower.updatedAt),
        DateTime.toEpochMillis(DateTime.makeUnsafe("2099-01-01T00:00:00.000Z")),
      );
    }).pipe(
      Effect.provide(
        BackgroundPolicy.layer.pipe(
          Layer.provide(
            Layer.effect(
              HostPowerMonitor.HostPowerMonitor,
              DateTime.now.pipe(
                Effect.flatMap((now) =>
                  HostPowerMonitor.make({
                    ...nominalHostPower,
                    updatedAt: now,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
