/**
 * The single place that turns cleanup settings plus measured free disk space
 * into the policy every automatic sweep reads live.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { ServerSettings, StorageLowDiskStatus, StorageVolume } from "@t3tools/contracts";
import { Cause, Context, Deferred, Duration, Effect, Layer, Ref, Schedule, Stream } from "effect";
import type { Scope } from "effect";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export const LOW_DISK_FREE_PERCENT = 10;
export const LOW_DISK_PROVIDER_LOG_RETENTION_DAYS = 3;
export const LOW_DISK_IDLE_WORKTREE_RECLAIM_DAYS = 1;
const DISK_STATUS_TTL_MS = 60_000;
const DISK_MONITOR_INTERVAL = "5 minutes";
const LOW_DISK_MAX_SWEEP_INTERVAL = Duration.minutes(15);

export interface EffectiveStorageCleanupPolicy {
  readonly automaticCleanupEnabled: boolean;
  readonly lowDisk: StorageLowDiskStatus;
  readonly providerLogRetentionDays: number | null;
  readonly providerLogMaxTotalMb: number | null;
  readonly idleWorktreeReclaimDays: number | null;
  readonly idleTerminalStopHours: number | null;
}

/** Low disk only shortens a retention window; an unset (`null`) window stays off. */
export function tightenRetention(
  setting: number | null,
  lowDiskCap: number,
  lowDiskActive: boolean,
): number | null {
  if (setting === null || !lowDiskActive) return setting;
  return Math.min(setting, lowDiskCap);
}

export function resolveEffectiveStorageCleanupPolicy(
  settings: Pick<
    ServerSettings,
    | "automaticCleanupEnabled"
    | "providerLogRetentionDays"
    | "providerLogMaxTotalMb"
    | "idleWorktreeReclaimDays"
    | "idleTerminalStopHours"
  >,
  lowDisk: StorageLowDiskStatus,
): EffectiveStorageCleanupPolicy {
  return {
    automaticCleanupEnabled: settings.automaticCleanupEnabled,
    lowDisk,
    providerLogRetentionDays: tightenRetention(
      settings.providerLogRetentionDays,
      LOW_DISK_PROVIDER_LOG_RETENTION_DAYS,
      lowDisk.active,
    ),
    providerLogMaxTotalMb: settings.providerLogMaxTotalMb,
    idleWorktreeReclaimDays: tightenRetention(
      settings.idleWorktreeReclaimDays,
      LOW_DISK_IDLE_WORKTREE_RECLAIM_DAYS,
      lowDisk.active,
    ),
    idleTerminalStopHours: settings.idleTerminalStopHours,
  };
}

export function summarizeLowDisk(volumes: ReadonlyArray<StorageVolume>): StorageLowDiskStatus {
  const freePercent =
    volumes.length === 0 ? null : Math.min(...volumes.map((volume) => volume.freePercent));
  return {
    active: freePercent !== null && freePercent < LOW_DISK_FREE_PERCENT,
    thresholdPercent: LOW_DISK_FREE_PERCENT,
    freePercent,
    volumes,
  };
}

export interface FreeSpace {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

export class StorageFreeSpaceProbe extends Context.Service<
  StorageFreeSpaceProbe,
  { readonly probe: (target: string) => Promise<FreeSpace | null> }
>()("t3/storage/StorageFreeSpaceProbe") {}

/** Probe the nearest existing ancestor so not-yet-created roots still report their volume. */
async function statfsNearest(target: string): Promise<FreeSpace | null> {
  let current = path.resolve(target);
  for (;;) {
    try {
      const stats = await fs.statfs(current);
      return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) return null;
      current = parent;
    }
  }
}

export const StorageFreeSpaceProbeLive = Layer.succeed(StorageFreeSpaceProbe, {
  probe: statfsNearest,
});

export interface StorageCleanupPolicyShape {
  /** Live policy: current settings and a free-space reading at most a minute old. */
  readonly current: Effect.Effect<EffectiveStorageCleanupPolicy>;
  readonly measureLowDisk: Effect.Effect<StorageLowDiskStatus>;
  /**
   * Repeat an automatic sweep in the caller's scope. Paused sweeps are skipped,
   * not interrupted; low disk and re-enabling the master switch wake it early.
   */
  readonly runAutomatic: (input: {
    readonly name: string;
    readonly initialDelay: Duration.Input;
    readonly interval: Duration.Input;
    readonly sweep: (policy: EffectiveStorageCleanupPolicy) => Effect.Effect<void>;
  }) => Effect.Effect<void, never, Scope.Scope>;
}

export class StorageCleanupPolicy extends Context.Service<
  StorageCleanupPolicy,
  StorageCleanupPolicyShape
>()("t3/storage/StorageCleanupPolicy") {}

const UNMEASURED: StorageLowDiskStatus = summarizeLowDisk([]);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const engine = yield* OrchestrationEngineService;
  const probe = yield* StorageFreeSpaceProbe;
  const cached = yield* Ref.make<{ readonly at: number; readonly status: StorageLowDiskStatus }>({
    at: 0,
    status: UNMEASURED,
  });
  const wake = yield* Ref.make(yield* Deferred.make<void>());

  const signalWake = Effect.gen(function* () {
    const next = yield* Deferred.make<void>();
    const previous = yield* Ref.getAndSet(wake, next);
    yield* Deferred.succeed(previous, undefined);
  });

  const measureLowDisk = Effect.gen(function* () {
    const readModel = yield* engine.getReadModel();
    const roots = new Set<string>([config.stateDir, config.worktreesDir]);
    for (const project of readModel.projects) {
      if (project.deletedAt === null) {
        roots.add(path.join(path.dirname(project.workspaceRoot), ".t3-thread-workspaces"));
      }
    }
    const readings = yield* Effect.forEach(
      [...roots],
      (root) =>
        Effect.promise(() => probe.probe(root)).pipe(
          Effect.map((space) => (space === null ? null : { root, space })),
        ),
      { concurrency: 4 },
    );
    // Many roots share one volume; report each distinct reading once.
    const volumes = new Map<string, StorageVolume>();
    for (const reading of readings) {
      if (reading === null || reading.space.totalBytes <= 0) continue;
      const key = `${reading.space.totalBytes}:${reading.space.freeBytes}`;
      if (volumes.has(key)) continue;
      volumes.set(key, {
        path: reading.root,
        freeBytes: reading.space.freeBytes,
        totalBytes: reading.space.totalBytes,
        freePercent: (reading.space.freeBytes / reading.space.totalBytes) * 100,
      });
    }
    const status = summarizeLowDisk([...volumes.values()]);
    const previous = yield* Ref.getAndSet(cached, { at: Date.now(), status });
    if (status.active && !previous.status.active) {
      yield* Effect.logWarning("storage.low-disk: entering low disk mode", {
        freePercent: status.freePercent,
        volumes: status.volumes,
      });
      yield* signalWake;
    }
    return status;
  });

  const lowDiskStatus = Effect.gen(function* () {
    const entry = yield* Ref.get(cached);
    return Date.now() - entry.at < DISK_STATUS_TTL_MS ? entry.status : yield* measureLowDisk;
  });

  const current = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    return resolveEffectiveStorageCleanupPolicy(settings, yield* lowDiskStatus);
  }).pipe(
    // Unreadable settings must never widen cleanup: treat them as paused.
    Effect.catch((error) =>
      Effect.logWarning("storage.policy: settings unavailable; automatic cleanup paused", {
        error,
      }).pipe(
        Effect.andThen(Ref.get(cached)),
        Effect.map(
          (entry): EffectiveStorageCleanupPolicy => ({
            automaticCleanupEnabled: false,
            lowDisk: entry.status,
            providerLogRetentionDays: null,
            providerLogMaxTotalMb: null,
            idleWorktreeReclaimDays: null,
            idleTerminalStopHours: null,
          }),
        ),
      ),
    ),
  );

  yield* Effect.forkScoped(
    measureLowDisk.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("storage.low-disk: free space probe failed", {
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.repeat(Schedule.spaced(DISK_MONITOR_INTERVAL)),
    ),
  );
  yield* Effect.forkScoped(
    settingsService.streamChanges.pipe(
      Stream.map((settings) => settings.automaticCleanupEnabled),
      Stream.changes,
      Stream.runForEach((enabled) => (enabled ? signalWake : Effect.void)),
    ),
  );

  const runAutomatic: StorageCleanupPolicyShape["runAutomatic"] = (input) => {
    const once = Effect.gen(function* () {
      const policy = yield* current;
      if (!policy.automaticCleanupEnabled) {
        yield* Effect.logDebug("storage.automatic: paused by master switch", { sweep: input.name });
        return policy;
      }
      yield* input.sweep(policy).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("storage.automatic: sweep failed", {
                sweep: input.name,
                cause: Cause.pretty(cause),
              }),
        ),
      );
      return policy;
    });
    const waitForNext = (policy: EffectiveStorageCleanupPolicy) =>
      Effect.gen(function* () {
        const signal = yield* Ref.get(wake);
        const interval = Duration.fromInputUnsafe(input.interval);
        const delay = policy.lowDisk.active
          ? Duration.min(interval, LOW_DISK_MAX_SWEEP_INTERVAL)
          : interval;
        yield* Effect.raceFirst(Effect.sleep(delay), Deferred.await(signal));
      });
    return Effect.forkScoped(
      Effect.sleep(input.initialDelay).pipe(
        Effect.andThen(Effect.forever(once.pipe(Effect.flatMap(waitForNext)))),
      ),
    ).pipe(Effect.asVoid);
  };

  return { current, measureLowDisk, runAutomatic } satisfies StorageCleanupPolicyShape;
});

/** Fixed policy for tests that do not exercise cleanup policy itself. */
export const makeStorageCleanupPolicyTest = (
  overrides: Partial<Omit<EffectiveStorageCleanupPolicy, "lowDisk">> = {},
) =>
  Layer.succeed(StorageCleanupPolicy, {
    current: Effect.succeed({
      automaticCleanupEnabled: true,
      lowDisk: UNMEASURED,
      providerLogRetentionDays: 14,
      providerLogMaxTotalMb: 5120,
      idleWorktreeReclaimDays: 7,
      idleTerminalStopHours: 4,
      ...overrides,
    }),
    measureLowDisk: Effect.succeed(UNMEASURED),
    runAutomatic: (input) =>
      Effect.forkScoped(
        Effect.sleep(input.initialDelay).pipe(
          Effect.andThen(
            Effect.forever(
              Effect.gen(function* () {
                yield* input
                  .sweep({
                    automaticCleanupEnabled: true,
                    lowDisk: UNMEASURED,
                    providerLogRetentionDays: 14,
                    providerLogMaxTotalMb: 5120,
                    idleWorktreeReclaimDays: 7,
                    idleTerminalStopHours: 4,
                    ...overrides,
                  })
                  .pipe(Effect.ignoreCause({ log: true }));
                yield* Effect.sleep(input.interval);
              }),
            ),
          ),
        ),
      ).pipe(Effect.asVoid),
  });

/** Live settings without disk probing, for tests that change settings mid-test. */
export const StorageCleanupPolicyFromSettingsTest = Layer.effect(
  StorageCleanupPolicy,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const current = Effect.map(settings.getSettings, (value) =>
      resolveEffectiveStorageCleanupPolicy(value, UNMEASURED),
    ).pipe(Effect.orDie);
    return {
      current,
      measureLowDisk: Effect.succeed(UNMEASURED),
      runAutomatic: (input) =>
        Effect.forkScoped(
          Effect.sleep(input.initialDelay).pipe(
            Effect.andThen(
              Effect.forever(
                current.pipe(
                  Effect.flatMap((policy) =>
                    policy.automaticCleanupEnabled ? input.sweep(policy) : Effect.void,
                  ),
                  Effect.andThen(Effect.sleep(input.interval)),
                ),
              ),
            ),
          ),
        ).pipe(Effect.asVoid),
    } satisfies StorageCleanupPolicyShape;
  }),
);

/** Requires a {@link StorageFreeSpaceProbe}, so tests can inject free space. */
export const StorageCleanupPolicyLayer = Layer.effect(StorageCleanupPolicy, make);

export const StorageCleanupPolicyLive = StorageCleanupPolicyLayer.pipe(
  Layer.provideMerge(StorageFreeSpaceProbeLive),
);
