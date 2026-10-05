/** SQLite free-page reclamation, gated so it never competes with live work. */
import fs from "node:fs/promises";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const GB = 1024 * 1024 * 1024;
/** Conservative rewrite throughput used only for the user-facing estimate. */
const VACUUM_BYTES_PER_SECOND = 100 * 1024 * 1024;

export interface DatabaseStats {
  readonly fileBytes: number;
  readonly walBytes: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freelistCount: number;
  readonly reclaimableBytes: number;
  readonly incrementalAutoVacuum: boolean;
}

async function fileSize(filePath: string): Promise<number> {
  return fs.stat(filePath).then(
    (stat) => stat.size,
    () => 0,
  );
}

const pragmaNumber = (sql: SqlClient.SqlClient, pragma: string) =>
  sql
    .unsafe<Record<string, unknown>>(`PRAGMA ${pragma}`)
    .pipe(Effect.map((rows) => Number(Object.values(rows[0] ?? {})[0] ?? 0)));

export const readDatabaseStats = (dbPath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [pageSize, pageCount, freelistCount, autoVacuum] = yield* Effect.all([
      pragmaNumber(sql, "page_size"),
      pragmaNumber(sql, "page_count"),
      pragmaNumber(sql, "freelist_count"),
      pragmaNumber(sql, "auto_vacuum"),
    ]);
    const [fileBytes, walBytes] = yield* Effect.promise(() =>
      Promise.all([fileSize(dbPath), fileSize(`${dbPath}-wal`)]),
    );
    return {
      fileBytes,
      walBytes,
      pageSize,
      pageCount,
      freelistCount,
      reclaimableBytes: freelistCount * pageSize,
      incrementalAutoVacuum: autoVacuum === 2,
    } satisfies DatabaseStats;
  });

export function estimateVacuumDurationMs(stats: DatabaseStats): number {
  return Math.round(((stats.fileBytes - stats.reclaimableBytes) / VACUUM_BYTES_PER_SECOND) * 1000);
}

export type VacuumDecision = { readonly run: true } | { readonly run: false; readonly reason: string };

/**
 * Automatic VACUUM runs only when it is worth it (free pages above max(1 GB,
 * 25% of the file)), safe for the disk (VACUUM can briefly need a full copy
 * plus WAL, so require 2x the file free), and no live work would be blocked.
 */
export function evaluateAutomaticVacuum(input: {
  readonly automaticCleanupEnabled: boolean;
  readonly stats: DatabaseStats;
  readonly freeDiskBytes: number | null;
  readonly busyReason: string | null;
}): VacuumDecision {
  if (!input.automaticCleanupEnabled) return { run: false, reason: "automatic cleanup is paused" };
  const disk = vacuumDiskBlocker(input.stats, input.freeDiskBytes);
  const threshold = Math.max(GB, input.stats.fileBytes * 0.25);
  if (input.stats.reclaimableBytes <= threshold) {
    return { run: false, reason: "reclaimable space is below the threshold" };
  }
  if (disk !== null) return { run: false, reason: disk };
  if (input.busyReason !== null) return { run: false, reason: input.busyReason };
  return { run: true };
}

/** Disk-space rule shared by automatic and manual VACUUM. */
export function vacuumDiskBlocker(stats: DatabaseStats, freeDiskBytes: number | null) {
  if (freeDiskBytes === null) return "free disk space is unknown";
  if (freeDiskBytes < stats.fileBytes * 2) {
    return "needs free disk space of at least twice the database size";
  }
  return null;
}

/**
 * Rewrite the database to return free pages to the filesystem. Uses
 * incremental vacuum when the database is configured for it.
 */
export const vacuumDatabase = (dbPath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* readDatabaseStats(dbPath);
    const startedAt = Date.now();
    yield* sql.unsafe(before.incrementalAutoVacuum ? "PRAGMA incremental_vacuum" : "VACUUM");
    // In WAL mode the file only shrinks once the rewrite is checkpointed.
    yield* sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)");
    const after = yield* readDatabaseStats(dbPath);
    const result = {
      durationMs: Date.now() - startedAt,
      bytesBefore: before.fileBytes + before.walBytes,
      bytesAfter: after.fileBytes + after.walBytes,
      bytesReclaimed: Math.max(0, before.fileBytes + before.walBytes - after.fileBytes - after.walBytes),
      mode: before.incrementalAutoVacuum ? "incremental" : "full",
    };
    yield* Effect.logInfo("storage.vacuum: database vacuumed", result);
    return result;
  });
