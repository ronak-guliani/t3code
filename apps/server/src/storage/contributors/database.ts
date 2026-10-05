/** The SQLite database, its stale `state.sqlite.before-*` backups, and VACUUM. */
import fs from "node:fs/promises";
import path from "node:path";

import type { StorageCleanupItemResult } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  estimateVacuumDurationMs,
  readDatabaseStats,
  vacuumDatabase,
  vacuumDiskBlocker,
} from "../databaseVacuum.ts";
import { measureDirectory } from "../measureDirectory.ts";
import { StorageFreeSpaceProbe } from "../StorageCleanupPolicy.ts";
import type { StorageCleanupContributor, StoragePlanEntry } from "../StorageCleanup.ts";

type DatabasePayload = { readonly kind: "backup"; readonly path: string } | { readonly kind: "vacuum" };

/** Running turns write constantly; VACUUM would stall them behind its rewrite. */
export const liveWorkBlocker = (snapshots: ProjectionSnapshotQuery["Service"]) =>
  snapshots.getShellSnapshot().pipe(
    Effect.map((shell) => {
      const busy = shell.threads.filter(
        (thread) =>
          thread.session?.activeTurnId != null ||
          thread.latestTurn?.state === "running" ||
          thread.pendingTurnStart != null,
      ).length;
      return busy === 0 ? null : `${busy} chat${busy === 1 ? " has a" : "s have"} running turn`;
    }),
    Effect.orElseSucceed(() => "live work could not be checked"),
  );

export const makeDatabaseStorageContributor = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const snapshots = yield* ProjectionSnapshotQuery;
  const probe = yield* StorageFreeSpaceProbe;
  const backupPrefix = `${path.basename(config.dbPath)}.before-`;

  const stats = readDatabaseStats(config.dbPath).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );

  const listBackups = Effect.promise(async () => {
    const entries = await fs.readdir(config.stateDir).catch(() => [] as string[]);
    return entries
      .filter((name) => name.startsWith(backupPrefix))
      .map((name) => path.join(config.stateDir, name));
  });

  const measure: StorageCleanupContributor["measure"] = ({ signal, report }) =>
    Effect.gen(function* () {
      const current = yield* stats;
      yield* report({
        category: "database",
        status: "complete",
        bytes: current.fileBytes + current.walBytes,
        items: 1,
        reclaimableBytes: current.reclaimableBytes,
      });
      const backups = yield* listBackups;
      const sizes = yield* Effect.forEach(backups, (backup) =>
        Effect.promise(() => measureDirectory(backup, { signal })),
      );
      yield* report({
        category: "databaseBackups",
        status: "complete",
        bytes: sizes.reduce((sum, size) => sum + size.bytes, 0),
        items: backups.length,
      });
    });

  const plan: StorageCleanupContributor["plan"] = (_policy, mode) =>
    Effect.gen(function* () {
      if (mode !== "reset") return [];
      const backups = yield* listBackups;
      const entries: Array<StoragePlanEntry<DatabasePayload>> = yield* Effect.forEach(
        backups,
        (backup) =>
          Effect.promise(() => measureDirectory(backup)).pipe(
            Effect.map((size) => ({
              item: {
                id: `database-backup:${path.basename(backup)}`,
                category: "databaseBackups" as const,
                description: `Database backup ${path.basename(backup)}`,
                target: backup,
                estimatedBytes: size.bytes,
                defaultSelected: true,
                needsManualReview: false,
              },
              payload: { kind: "backup" as const, path: backup },
            })),
          ),
      );
      const current = yield* stats;
      if (current.reclaimableBytes > 0) {
        const durationMs = estimateVacuumDurationMs(current);
        entries.push({
          item: {
            id: "database-vacuum",
            category: "database",
            description: `Compact the database (VACUUM, about ${Math.max(1, Math.ceil(durationMs / 1000))} s; new messages wait while it runs)`,
            target: config.dbPath,
            estimatedBytes: current.reclaimableBytes,
            defaultSelected: false,
            needsManualReview: false,
            estimatedDurationMs: durationMs,
          },
          payload: { kind: "vacuum" },
        });
      }
      return entries;
    });

  const executeOne = (entry: StoragePlanEntry) =>
    Effect.gen(function* () {
      const payload = entry.payload as DatabasePayload;
      const result = (
        status: StorageCleanupItemResult["status"],
        bytesFreed: number,
        reason: string | null,
      ): StorageCleanupItemResult => ({
        itemId: entry.item.id,
        category: entry.item.category,
        description: entry.item.description,
        status,
        bytesFreed,
        reason,
      });
      if (payload.kind === "backup") {
        // Re-validate the name: never touch the live database or its WAL/SHM.
        const name = path.basename(payload.path);
        if (
          path.dirname(payload.path) !== config.stateDir ||
          !name.startsWith(backupPrefix) ||
          payload.path === config.dbPath
        ) {
          return result("skipped", 0, "not a database backup");
        }
        const size = yield* Effect.promise(() => measureDirectory(payload.path));
        if (size.files === 0) return result("skipped", 0, "already deleted");
        yield* Effect.promise(() => fs.rm(payload.path, { recursive: true, force: true }));
        return result("removed", size.bytes, "stale database backup");
      }
      const busy = yield* liveWorkBlocker(snapshots);
      if (busy !== null) return result("skipped", 0, busy);
      const current = yield* stats;
      const space = yield* Effect.promise(() => probe.probe(config.stateDir));
      const disk = vacuumDiskBlocker(current, space?.freeBytes ?? null);
      if (disk !== null) return result("skipped", 0, disk);
      const vacuumed = yield* vacuumDatabase(config.dbPath).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      return result(
        "removed",
        vacuumed.bytesReclaimed,
        `${vacuumed.mode} vacuum took ${Math.round(vacuumed.durationMs / 1000)} s`,
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed<StorageCleanupItemResult>({
          itemId: entry.item.id,
          category: entry.item.category,
          description: entry.item.description,
          status: "failed",
          bytesFreed: 0,
          reason: error.message,
        }),
      ),
    );

  return {
    id: "database",
    categories: ["database", "databaseBackups"],
    measure,
    plan,
    execute: (entries) => Effect.forEach(entries, executeOne, { concurrency: 1 }),
  } satisfies StorageCleanupContributor;
});
