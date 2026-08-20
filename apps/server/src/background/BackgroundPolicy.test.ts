import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  RpcClientId,
  type ClientActivityReportInput,
  type HostPowerSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

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

function connection(
  rpcClientId: number,
  generation = BigInt(rpcClientId),
): BackgroundPolicy.BackgroundConnectionIdentity {
  return {
    rpcClientId: RpcClientId.make(rpcClientId),
    generation,
  };
}

const registerConnections = (
  policy: BackgroundPolicy.BackgroundPolicy["Service"],
  sessionId: AuthSessionId,
  ...connections: ReadonlyArray<BackgroundPolicy.BackgroundConnectionIdentity>
) =>
  Effect.forEach(
    connections,
    (clientConnection) => policy.registerConnection(sessionId, clientConnection),
    { discard: true },
  );

describe("BackgroundPolicy", () => {
  it.effect("records the official mobile activity lease and removes it on disconnect", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("mobile-session");
      const clientConnection = connection(1);

      yield* registerConnections(policy, sessionId, clientConnection);
      yield* policy.reportClientActivity(sessionId, clientConnection, makeReport());
      const connected = yield* policy.snapshot;

      assert.equal(connected.activeForegroundLeaseCount, 1);
      assert.deepStrictEqual(connected.activeScopeKeys, ["provider-status"]);
      assert.equal(connected.leases[0]?.clientKind, "mobile");
      assert.equal(connected.shouldRunOpportunisticWork, true);

      yield* policy.removeConnection(sessionId, clientConnection);
      yield* policy.reportClientActivity(sessionId, clientConnection, makeReport());
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
      const oldConnection = connection(1);
      const replacementConnection = connection(2);

      yield* registerConnections(policy, sessionId, oldConnection, replacementConnection);
      yield* policy.reportClientActivity(
        sessionId,
        oldConnection,
        makeReport({ clientId: "stable-mobile-device" }),
      );
      yield* policy.reportClientActivity(
        sessionId,
        replacementConnection,
        makeReport({
          clientId: "stable-mobile-device",
          scopes: [{ type: "server-config" }],
        }),
      );
      yield* policy.reportClientActivity(
        sessionId,
        oldConnection,
        makeReport({
          clientId: "stable-mobile-device",
          scopes: [{ type: "diagnostics" }],
        }),
      );
      yield* policy.removeConnection(sessionId, oldConnection);

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.leases.length, 1);
      assert.equal(snapshot.leases[0]?.rpcClientId, replacementConnection.rpcClientId);
      assert.equal(snapshot.leases[0]?.clientId, "stable-mobile-device");
      assert.deepStrictEqual(snapshot.leases[0]?.scopes, [{ type: "server-config" }]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("keeps replacement ownership after its lease expires", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("mobile-session");
      const oldConnection = connection(1);
      const replacementConnection = connection(2);
      const report = makeReport({
        clientId: "stable-mobile-device",
        ttlMs: 1_000,
      });

      yield* registerConnections(policy, sessionId, oldConnection, replacementConnection);
      yield* policy.reportClientActivity(sessionId, oldConnection, report);
      yield* policy.reportClientActivity(sessionId, replacementConnection, report);
      yield* TestClock.adjust("1001 millis");
      yield* policy.reportClientActivity(sessionId, oldConnection, report);

      const afterLateReport = yield* policy.snapshot;
      assert.equal(afterLateReport.leases.length, 0);

      yield* policy.reportClientActivity(sessionId, replacementConnection, report);
      const afterReplacementReport = yield* policy.snapshot;
      assert.equal(afterReplacementReport.leases.length, 1);
      assert.equal(
        afterReplacementReport.leases[0]?.rpcClientId,
        replacementConnection.rpcClientId,
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("does not let an older connection reclaim after its replacement disconnects", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("mobile-session");
      const oldConnection = connection(1);
      const replacementConnection = connection(2);
      const report = makeReport({ clientId: "stable-mobile-device" });

      yield* registerConnections(policy, sessionId, oldConnection, replacementConnection);
      yield* policy.reportClientActivity(sessionId, oldConnection, report);
      yield* policy.reportClientActivity(sessionId, replacementConnection, report);
      yield* policy.removeConnection(sessionId, replacementConnection);
      yield* policy.reportClientActivity(sessionId, oldConnection, report);

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.leases.length, 0);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("does not let an older connection reclaim an evicted ownership key", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("mobile-session");
      const oldConnection = connection(1);
      const replacementConnection = connection(2);
      const displacedClientId = "stable-mobile-device";

      yield* registerConnections(policy, sessionId, oldConnection, replacementConnection);
      yield* policy.reportClientActivity(
        sessionId,
        oldConnection,
        makeReport({ clientId: displacedClientId }),
      );
      yield* policy.reportClientActivity(
        sessionId,
        replacementConnection,
        makeReport({ clientId: displacedClientId }),
      );
      for (
        let index = 0;
        index < BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT;
        index += 1
      ) {
        yield* policy.reportClientActivity(
          sessionId,
          replacementConnection,
          makeReport({ clientId: `replacement-device-${index}` }),
        );
      }
      yield* policy.reportClientActivity(
        sessionId,
        oldConnection,
        makeReport({ clientId: displacedClientId }),
      );

      const snapshot = yield* policy.snapshot;
      assert.isFalse(snapshot.leases.some((lease) => lease.clientId === displacedClientId));
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("filters lease metadata and aggregates by authenticated session", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const firstSession = AuthSessionId.make("session-1");
      const secondSession = AuthSessionId.make("session-2");
      yield* registerConnections(policy, firstSession, connection(1));
      yield* registerConnections(policy, secondSession, connection(2));
      yield* policy.reportClientActivity(
        firstSession,
        connection(1),
        makeReport({ clientId: "first-device" }),
      );
      yield* policy.reportClientActivity(
        secondSession,
        connection(2),
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
      const clientConnection = connection(1);

      yield* registerConnections(policy, sessionId, clientConnection);
      for (
        let index = 0;
        index <= BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT;
        index += 1
      ) {
        yield* policy.reportClientActivity(
          sessionId,
          clientConnection,
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

  it.effect("enforces the connection cap when stable client ids change owners", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("mobile-session");
      const replacementConnection = connection(1, 10_000n);
      yield* registerConnections(policy, sessionId, replacementConnection);

      for (
        let index = 0;
        index <= BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT;
        index += 1
      ) {
        const clientId = `mobile-device-${index}`;
        const originalConnection = connection(100 + index, BigInt(index));
        yield* registerConnections(policy, sessionId, originalConnection);
        yield* policy.reportClientActivity(sessionId, originalConnection, makeReport({ clientId }));
        yield* policy.reportClientActivity(
          sessionId,
          replacementConnection,
          makeReport({ clientId }),
        );
      }

      const snapshot = yield* policy.snapshot;
      assert.equal(
        snapshot.leases.filter((lease) => lease.rpcClientId === replacementConnection.rpcClientId)
          .length,
        BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT,
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("does not forward another session's activity heartbeat", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const firstSession = AuthSessionId.make("session-1");
      const secondSession = AuthSessionId.make("session-2");
      yield* registerConnections(policy, firstSession, connection(1));
      yield* registerConnections(policy, secondSession, connection(2));
      yield* policy.reportClientActivity(
        firstSession,
        connection(1),
        makeReport({ clientId: "first-device" }),
      );
      yield* policy.reportClientActivity(
        secondSession,
        connection(2),
        makeReport({ clientId: "second-device" }),
      );
      const subscription = yield* policy.subscribeForSession(firstSession);
      const nextSnapshot = yield* Stream.runHead(subscription.changes).pipe(Effect.forkChild);

      yield* policy.reportClientActivity(
        secondSession,
        connection(2),
        makeReport({ clientId: "second-device" }),
      );
      yield* Effect.yieldNow;
      yield* policy.reportClientActivity(
        firstSession,
        connection(1),
        makeReport({
          clientId: "first-device",
          recentlyInteracted: false,
        }),
      );

      const next = Option.getOrThrow(yield* Fiber.join(nextSnapshot));
      assert.equal(next.leases[0]?.clientId, "first-device");
      assert.equal(next.leases[0]?.recentlyInteracted, false);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("honors fresh host constraints without trusting stale power data", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("mobile-session");
      const clientConnection = connection(1);
      yield* registerConnections(policy, sessionId, clientConnection);
      yield* policy.reportClientActivity(sessionId, clientConnection, makeReport());

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

  it.effect("marks restrictive host power stale after reports stop", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("mobile-session");
      const clientConnection = connection(1);
      yield* registerConnections(policy, sessionId, clientConnection);
      yield* policy.reportClientActivity(
        sessionId,
        clientConnection,
        makeReport({ ttlMs: 120_000 }),
      );
      yield* policy.reportHostPowerState({
        ...nominalHostPower,
        source: "electron-main",
        lowPowerMode: "true",
        stale: false,
      });

      const constrained = yield* policy.snapshot;
      assert.equal(constrained.shouldRunOpportunisticWork, false);

      yield* TestClock.adjust(`${HostPowerMonitor.HOST_POWER_STALE_AFTER_MS} millis`);
      const stale = yield* policy.snapshot;
      assert.equal(stale.hostPower.stale, true);
      assert.equal(stale.shouldRunOpportunisticWork, true);
    }).pipe(
      Effect.provide(
        makeLayer({
          ...nominalHostPower,
          updatedAt: DateTime.makeUnsafe(0),
        }),
      ),
    ),
  );
});
