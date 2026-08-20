import {
  type AuthSessionId,
  type BackgroundPolicySnapshot,
  type BackgroundScope,
  type ClientActivityLease,
  type ClientActivityReportInput,
  type HostPowerSnapshot,
  type RpcClientId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";
import * as HostPowerMonitor from "./HostPowerMonitor.ts";

export interface BackgroundConnectionIdentity {
  readonly rpcClientId: RpcClientId;
  readonly generation: bigint;
}

interface StoredClientActivityLease {
  readonly lease: ClientActivityLease;
  readonly connectionGeneration: bigint;
}

interface ClientActivityOwner {
  readonly sessionId: AuthSessionId;
  readonly connectionGeneration: bigint;
  readonly claimedAt: DateTime.Utc;
}

interface OwnershipDecision {
  readonly accepted: boolean;
  readonly displacedGeneration: bigint | undefined;
  readonly evictedKey: string | undefined;
}

export class BackgroundPolicy extends Context.Service<
  BackgroundPolicy,
  {
    readonly registerConnection: (
      sessionId: AuthSessionId,
      connection: BackgroundConnectionIdentity,
    ) => Effect.Effect<void>;
    readonly reportClientActivity: (
      sessionId: AuthSessionId,
      connection: BackgroundConnectionIdentity,
      input: ClientActivityReportInput,
    ) => Effect.Effect<void>;
    readonly removeConnection: (
      sessionId: AuthSessionId,
      connection: BackgroundConnectionIdentity,
    ) => Effect.Effect<void>;
    readonly reportHostPowerState: (snapshot: HostPowerSnapshot) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<BackgroundPolicySnapshot>;
    readonly snapshotForSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<BackgroundPolicySnapshot>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: BackgroundPolicySnapshot;
        readonly changes: Stream.Stream<BackgroundPolicySnapshot>;
      },
      never,
      Scope.Scope
    >;
    readonly subscribeForSession: (sessionId: AuthSessionId) => Effect.Effect<
      {
        readonly latest: BackgroundPolicySnapshot;
        readonly changes: Stream.Stream<BackgroundPolicySnapshot>;
      },
      never,
      Scope.Scope
    >;
  }
>()("t3/background/BackgroundPolicy") {}

const DEFAULT_LEASE_TTL_MS = 45_000;
const MAX_LEASE_TTL_MS = 120_000;
export const MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT = 16;

function scopeKey(scope: BackgroundScope): string {
  switch (scope.type) {
    case "server-config":
    case "diagnostics":
      return scope.type;
    case "provider-status":
      return scope.instanceId ? `${scope.type}:${scope.instanceId}` : scope.type;
    case "vcs-status":
    case "git-refs":
      return `${scope.type}:${scope.cwd}`;
    case "thread":
      return `${scope.type}:${scope.threadId}`;
  }
}

function isLeaseActive(lease: ClientActivityLease, now: DateTime.Utc): boolean {
  return DateTime.isGreaterThan(lease.expiresAt, now);
}

function leaseKey(lease: Pick<ClientActivityLease, "sessionId" | "clientId">) {
  return JSON.stringify([lease.sessionId, lease.clientId]);
}

function upsertClientActivityLease(
  leases: ReadonlyMap<string, StoredClientActivityLease>,
  lease: ClientActivityLease,
  connectionGeneration: bigint,
  now: DateTime.Utc,
): {
  readonly leases: Map<string, StoredClientActivityLease>;
  readonly changed: boolean;
} {
  const next = new Map(leases);
  let changed = false;
  for (const [key, current] of next) {
    if (!isLeaseActive(current.lease, now)) {
      next.delete(key);
      changed = true;
    }
  }

  const key = leaseKey(lease);
  const existing = next.get(key);
  if (existing !== undefined && existing.connectionGeneration > connectionGeneration) {
    return { leases: next, changed };
  }
  if (existing === undefined || existing.connectionGeneration !== connectionGeneration) {
    const connectionLeases = [...next.entries()]
      .filter(
        ([, current]) =>
          current.lease.sessionId === lease.sessionId &&
          current.connectionGeneration === connectionGeneration,
      )
      .toSorted(([, left], [, right]) =>
        DateTime.isLessThan(left.lease.updatedAt, right.lease.updatedAt) ? -1 : 1,
      );
    if (connectionLeases.length >= MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT) {
      next.delete(connectionLeases[0]![0]);
      changed = true;
    }
  }

  next.set(key, { lease, connectionGeneration });
  return { leases: next, changed: true };
}

function sameSessionSnapshot(
  left: BackgroundPolicySnapshot,
  right: BackgroundPolicySnapshot,
): boolean {
  return (
    Equal.equals(left.hostPower, right.hostPower) &&
    Equal.equals(left.leases, right.leases) &&
    left.activeForegroundLeaseCount === right.activeForegroundLeaseCount &&
    Equal.equals(left.activeScopeKeys, right.activeScopeKeys) &&
    left.shouldRunOpportunisticWork === right.shouldRunOpportunisticWork
  );
}

function isForegroundLease(lease: ClientActivityLease, now: DateTime.Utc): boolean {
  return isLeaseActive(lease, now) && lease.visible && (lease.focused || lease.recentlyInteracted);
}

function hostAllowsWork(hostPower: HostPowerSnapshot): boolean {
  if (hostPower.stale) {
    return true;
  }
  return (
    !hostPower.suspended &&
    hostPower.locked !== "true" &&
    hostPower.lowPowerMode !== "true" &&
    hostPower.thermalState !== "serious" &&
    hostPower.thermalState !== "critical"
  );
}

function clientAllowsWork(lease: ClientActivityLease): boolean {
  return lease.lowPowerMode !== "true";
}

function computeSnapshot(input: {
  readonly hostPower: HostPowerSnapshot;
  readonly leases: ReadonlyMap<string, StoredClientActivityLease>;
  readonly now: DateTime.Utc;
}): BackgroundPolicySnapshot {
  const activeLeases = [...input.leases.values()]
    .map(({ lease }) => lease)
    .filter((lease) => isLeaseActive(lease, input.now));
  const foregroundLeases = activeLeases.filter((lease) => isForegroundLease(lease, input.now));
  const activeScopeKeys = new Set<string>();
  for (const lease of activeLeases) {
    for (const scope of lease.scopes) {
      activeScopeKeys.add(scopeKey(scope));
    }
  }

  return {
    hostPower: input.hostPower,
    leases: activeLeases,
    activeForegroundLeaseCount: foregroundLeases.length,
    activeScopeKeys: [...activeScopeKeys].toSorted(),
    shouldRunOpportunisticWork:
      hostAllowsWork(input.hostPower) && foregroundLeases.some(clientAllowsWork),
    updatedAt: input.now,
  };
}

function filterSnapshotForSession(
  snapshot: BackgroundPolicySnapshot,
  sessionId: AuthSessionId,
): BackgroundPolicySnapshot {
  const leases = snapshot.leases.filter((lease) => lease.sessionId === sessionId);
  const activeScopeKeys = new Set<string>();
  for (const lease of leases) {
    for (const scope of lease.scopes) {
      activeScopeKeys.add(scopeKey(scope));
    }
  }
  const foregroundLeases = leases.filter(
    (lease) => lease.visible && (lease.focused || lease.recentlyInteracted),
  );
  return {
    ...snapshot,
    leases,
    activeForegroundLeaseCount: foregroundLeases.length,
    activeScopeKeys: [...activeScopeKeys].toSorted(),
    shouldRunOpportunisticWork:
      hostAllowsWork(snapshot.hostPower) && foregroundLeases.some(clientAllowsWork),
  };
}

export const make = Effect.fn("background.policy.make")(function* () {
  const hostPowerMonitor = yield* HostPowerMonitor.HostPowerMonitor;
  const leasesRef = yield* Ref.make(new Map<string, StoredClientActivityLease>());
  const ownersRef = yield* Ref.make(new Map<string, ClientActivityOwner>());
  const activeConnectionsRef = yield* Ref.make(new Map<AuthSessionId, ReadonlySet<bigint>>());
  const supersededConnectionsRef = yield* Ref.make(new Map<AuthSessionId, ReadonlySet<bigint>>());
  const changes = yield* PubSub.sliding<BackgroundPolicySnapshot>(1);
  const publishMutex = yield* Semaphore.make(1);

  const snapshot = Effect.gen(function* () {
    const [hostPower, leases, now] = yield* Effect.all([
      hostPowerMonitor.snapshot,
      Ref.get(leasesRef),
      DateTime.now,
    ]);
    return computeSnapshot({ hostPower, leases, now });
  });

  const publishSnapshotUnlocked = snapshot.pipe(
    Effect.flatMap((next) => PubSub.publish(changes, next)),
  );
  const publishSnapshot = publishMutex.withPermits(1)(publishSnapshotUnlocked);

  const reportClientActivity: BackgroundPolicy["Service"]["reportClientActivity"] = (
    sessionId,
    connection,
    input,
  ) =>
    publishMutex.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const ttlMs = Math.min(
            Math.max(input.ttlMs ?? DEFAULT_LEASE_TTL_MS, 1_000),
            MAX_LEASE_TTL_MS,
          );
          const now = yield* DateTime.now;
          const lease: ClientActivityLease = {
            sessionId,
            rpcClientId: connection.rpcClientId,
            clientId: input.clientId,
            clientKind: input.clientKind,
            visible: input.visible,
            focused: input.focused,
            recentlyInteracted: input.recentlyInteracted,
            ...(input.appState !== undefined ? { appState: input.appState } : {}),
            ...(input.lowPowerMode !== undefined ? { lowPowerMode: input.lowPowerMode } : {}),
            ...(input.batteryState !== undefined ? { batteryState: input.batteryState } : {}),
            ...(input.networkType !== undefined ? { networkType: input.networkType } : {}),
            scopes: input.scopes,
            updatedAt: now,
            expiresAt: DateTime.add(now, { milliseconds: ttlMs }),
          };
          const [connectionActive, connectionSuperseded] = yield* Effect.all([
            Ref.get(activeConnectionsRef).pipe(
              Effect.map(
                (activeConnections) =>
                  activeConnections.get(sessionId)?.has(connection.generation) === true,
              ),
            ),
            Ref.get(supersededConnectionsRef).pipe(
              Effect.map(
                (supersededConnections) =>
                  supersededConnections.get(sessionId)?.has(connection.generation) === true,
              ),
            ),
          ]);
          if (!connectionActive || connectionSuperseded) {
            return;
          }
          const ownership = yield* Ref.modify(ownersRef, (owners) => {
            const key = leaseKey(lease);
            const owner = owners.get(key);
            if (owner !== undefined && owner.connectionGeneration > connection.generation) {
              const decision: OwnershipDecision = {
                accepted: false,
                displacedGeneration: undefined,
                evictedKey: undefined,
              };
              return [decision, owners] as const;
            }
            const next = new Map(owners);
            let evictedKey: string | undefined;
            if (owner === undefined || owner.connectionGeneration !== connection.generation) {
              const connectionOwners = [...next.entries()]
                .filter(
                  ([, current]) =>
                    current.sessionId === sessionId &&
                    current.connectionGeneration === connection.generation,
                )
                .toSorted(([, left], [, right]) =>
                  DateTime.isLessThan(left.claimedAt, right.claimedAt) ? -1 : 1,
                );
              if (connectionOwners.length >= MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT) {
                evictedKey = connectionOwners[0]![0];
                next.delete(evictedKey);
              }
            }
            next.set(key, {
              sessionId,
              connectionGeneration: connection.generation,
              claimedAt: now,
            });
            const decision: OwnershipDecision = {
              accepted: true,
              displacedGeneration:
                owner !== undefined && owner.connectionGeneration < connection.generation
                  ? owner.connectionGeneration
                  : undefined,
              evictedKey,
            };
            return [decision, next] as const;
          });
          if (!ownership.accepted) {
            return;
          }
          const displacedGeneration = ownership.displacedGeneration;
          if (displacedGeneration !== undefined) {
            yield* Ref.update(supersededConnectionsRef, (supersededConnections) => {
              const next = new Map(supersededConnections);
              const sessionConnections = new Set(next.get(sessionId) ?? []);
              sessionConnections.add(displacedGeneration);
              next.set(sessionId, sessionConnections);
              return next;
            });
          }
          const changed = yield* Ref.modify(leasesRef, (leases) => {
            const withoutEvicted = new Map(leases);
            if (ownership.evictedKey !== undefined) {
              withoutEvicted.delete(ownership.evictedKey);
            }
            const result = upsertClientActivityLease(
              withoutEvicted,
              lease,
              connection.generation,
              now,
            );
            return [result.changed, result.leases] as const;
          });
          if (changed) {
            yield* publishSnapshotUnlocked;
          }
        }),
      ),
    );

  const removeConnection: BackgroundPolicy["Service"]["removeConnection"] = (
    sessionId,
    connection,
  ) =>
    publishMutex.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Ref.update(activeConnectionsRef, (activeConnections) => {
            const next = new Map(activeConnections);
            const sessionConnections = new Set(next.get(sessionId) ?? []);
            sessionConnections.delete(connection.generation);
            if (sessionConnections.size === 0) {
              next.delete(sessionId);
            } else {
              next.set(sessionId, sessionConnections);
            }
            return next;
          });
          yield* Ref.update(supersededConnectionsRef, (supersededConnections) => {
            const next = new Map(supersededConnections);
            const sessionConnections = new Set(next.get(sessionId) ?? []);
            sessionConnections.delete(connection.generation);
            if (sessionConnections.size === 0) {
              next.delete(sessionId);
            } else {
              next.set(sessionId, sessionConnections);
            }
            return next;
          });
          yield* Ref.update(ownersRef, (owners) => {
            const next = new Map(owners);
            for (const [key, owner] of next) {
              if (
                owner.sessionId === sessionId &&
                owner.connectionGeneration === connection.generation
              ) {
                next.delete(key);
              }
            }
            return next;
          });
          const removed = yield* Ref.modify(leasesRef, (leases) => {
            const next = new Map(leases);
            let removed = false;
            for (const [key, stored] of next) {
              if (
                stored.lease.sessionId === sessionId &&
                stored.connectionGeneration === connection.generation
              ) {
                next.delete(key);
                removed = true;
              }
            }
            return [removed, next] as const;
          });
          if (removed) {
            yield* publishSnapshotUnlocked;
          }
        }),
      ),
    );

  yield* Stream.runForEach(hostPowerMonitor.streamChanges, () => publishSnapshot).pipe(
    Effect.forkScoped,
  );
  yield* Effect.forever(
    Effect.sleep("15 seconds").pipe(
      Effect.andThen(
        publishMutex.withPermits(1)(
          DateTime.now.pipe(
            Effect.flatMap((now) =>
              Ref.modify(leasesRef, (leases) => {
                const next = new Map(leases);
                let removed = false;
                for (const [key, stored] of next) {
                  if (!isLeaseActive(stored.lease, now)) {
                    next.delete(key);
                    removed = true;
                  }
                }
                return [removed, next] as const;
              }),
            ),
            Effect.flatMap((removed) => (removed ? publishSnapshotUnlocked : Effect.void)),
          ),
        ),
      ),
    ),
  ).pipe(Effect.forkScoped);

  return BackgroundPolicy.of({
    registerConnection: (sessionId, connection) =>
      publishMutex.withPermits(1)(
        Ref.update(activeConnectionsRef, (activeConnections) => {
          const next = new Map(activeConnections);
          const sessionConnections = new Set(next.get(sessionId) ?? []);
          sessionConnections.add(connection.generation);
          next.set(sessionId, sessionConnections);
          return next;
        }),
      ),
    reportClientActivity,
    removeConnection,
    reportHostPowerState: (reported) =>
      DateTime.now.pipe(
        Effect.flatMap((receivedAt) =>
          hostPowerMonitor.report({
            ...reported,
            updatedAt: receivedAt,
          }),
        ),
      ),
    snapshot,
    snapshotForSession: (sessionId) =>
      snapshot.pipe(Effect.map((current) => filterSnapshotForSession(current, sessionId))),
    subscribe: subscribeBeforeSnapshot(changes, snapshot, publishMutex),
    subscribeForSession: (sessionId) =>
      subscribeBeforeSnapshot(changes, snapshot, publishMutex).pipe(
        Effect.map(({ latest, changes: stream }) => {
          const filteredLatest = filterSnapshotForSession(latest, sessionId);
          return {
            latest: filteredLatest,
            changes: Stream.concat(
              Stream.make(filteredLatest),
              stream.pipe(Stream.map((current) => filterSnapshotForSession(current, sessionId))),
            ).pipe(Stream.changesWith(sameSessionSnapshot), Stream.drop(1)),
          };
        }),
      ),
  });
});

export const layer = Layer.effect(BackgroundPolicy, make());
