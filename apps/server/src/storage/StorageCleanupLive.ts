import { Cause, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeDatabaseStorageContributor, liveWorkBlocker } from "./contributors/database.ts";
import { makeLogStorageContributor } from "./contributors/logs.ts";
import { makeRuntimeFilesStorageContributor } from "./contributors/runtimeFiles.ts";
import { makeTerminalStorageContributor } from "./contributors/terminals.ts";
import { makeValidationStorageContributor } from "./contributors/validationEnvironments.ts";
import { makeWorktreeStorageContributor } from "./contributors/worktrees.ts";
import { evaluateAutomaticVacuum, readDatabaseStats, vacuumDatabase } from "./databaseVacuum.ts";
import { makeStorageCleanup, StorageCleanup } from "./StorageCleanup.ts";
import { StorageCleanupPolicy, StorageFreeSpaceProbe } from "./StorageCleanupPolicy.ts";

const AUTOMATIC_INITIAL_DELAY = "15 seconds";
const AUTOMATIC_INTERVAL = "6 hours";

const makeStartupVacuum = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const policyService = yield* StorageCleanupPolicy;
  const probe = yield* StorageFreeSpaceProbe;
  const snapshots = yield* ProjectionSnapshotQuery;
  return Effect.gen(function* () {
    const policy = yield* policyService.current;
    const stats = yield* readDatabaseStats(config.dbPath);
    const space = yield* Effect.promise(() => probe.probe(config.stateDir));
    const decision = evaluateAutomaticVacuum({
      automaticCleanupEnabled: policy.automaticCleanupEnabled,
      stats,
      freeDiskBytes: space?.freeBytes ?? null,
      busyReason: yield* liveWorkBlocker(snapshots),
    });
    if (!decision.run) {
      yield* Effect.logDebug("storage.vacuum: automatic vacuum skipped", {
        reason: decision.reason,
        reclaimableBytes: stats.reclaimableBytes,
        fileBytes: stats.fileBytes,
      });
      return;
    }
    yield* vacuumDatabase(config.dbPath);
  }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.catchCause((cause) =>
      Effect.logWarning("storage.vacuum: automatic vacuum failed", { cause: Cause.pretty(cause) }),
    ),
  );
});

export const StorageCleanupLive = Layer.effect(
  StorageCleanup,
  Effect.gen(function* () {
    const contributors = [
      yield* makeWorktreeStorageContributor,
      yield* makeLogStorageContributor,
      yield* makeDatabaseStorageContributor,
      yield* makeRuntimeFilesStorageContributor,
      yield* makeTerminalStorageContributor,
      yield* makeValidationStorageContributor(),
    ];
    const service = yield* makeStorageCleanup(contributors, yield* makeStartupVacuum);
    const policy = yield* StorageCleanupPolicy;
    yield* policy.runAutomatic({
      name: "storage-automatic",
      initialDelay: AUTOMATIC_INITIAL_DELAY,
      interval: AUTOMATIC_INTERVAL,
      sweep: service.runAutomaticSweep,
    });
    return service;
  }),
);
