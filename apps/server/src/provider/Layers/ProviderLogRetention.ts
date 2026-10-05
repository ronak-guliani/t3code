import fs from "node:fs/promises";
import path from "node:path";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";

const MAX_IO_CONCURRENCY = 4;
const HEAD_QUIET_PERIOD_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
type RemovalReason = "deletedThreads" | "unknownThreads" | "age" | "sizeCap";

export interface ProviderLogRetentionThread {
  readonly id: string;
  readonly deletedAt: string | null;
}

export interface ProviderLogSweepSummary {
  readonly scannedFiles: number;
  readonly removed: Readonly<
    Record<RemovalReason, { readonly files: number; readonly bytes: number }>
  >;
  readonly failedFiles: number;
  readonly remainingBytes: number;
}

export interface ProviderLogSweepInput {
  readonly providerLogsDir: string;
  readonly threads: ReadonlyArray<ProviderLogRetentionThread>;
  readonly liveThreadIds: ReadonlySet<string>;
  readonly retentionDays: number | null;
  readonly maxTotalMb: number | null;
  readonly nowMs?: number;
  /** Injectable only to exercise per-file filesystem failure handling. */
  readonly unlink?: (filePath: string) => Promise<void>;
}

interface LogFile {
  readonly name: string;
  readonly filePath: string;
  readonly threadSegment: string | null;
  readonly isRotation: boolean;
  readonly isSharedHead: boolean;
}

interface FileState extends LogFile {
  readonly size: number;
  readonly mtimeMs: number;
}

interface ThreadSegmentState {
  hasReadModelThread: boolean;
  allDeleted: boolean;
  hasLiveSession: boolean;
}

function emptyRemovalCounts(): Record<RemovalReason, { files: number; bytes: number }> {
  return {
    deletedThreads: { files: 0, bytes: 0 },
    unknownThreads: { files: 0, bytes: 0 },
    age: { files: 0, bytes: 0 },
    sizeCap: { files: 0, bytes: 0 },
  };
}

function classifyLogFile(name: string, directory: string): LogFile | null {
  const shared = /^(events\.log|provider-events\.ndjson|_global\.log)(?:\.(\d+))?$/.exec(name);
  if (shared) {
    const isRotation = shared[2] !== undefined;
    return {
      name,
      filePath: path.join(directory, name),
      threadSegment: null,
      isRotation,
      isSharedHead: !isRotation,
    };
  }

  const match = /^(.*)\.log(?:\.(\d+))?$/.exec(name);
  if (!match || !match[1]) return null;
  const isRotation = match[2] !== undefined;
  return {
    name,
    filePath: path.join(directory, name),
    threadSegment: match[1],
    isRotation,
    isSharedHead: false,
  };
}

async function forEachConcurrent<T>(
  values: ReadonlyArray<T>,
  f: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(MAX_IO_CONCURRENCY, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        await f(values[index]!);
      }
    }),
  );
}

function buildThreadSegmentStates(
  threads: ReadonlyArray<ProviderLogRetentionThread>,
  liveThreadIds: ReadonlySet<string>,
): Map<string, ThreadSegmentState> {
  const states = new Map<string, ThreadSegmentState>();
  const stateFor = (threadId: string): ThreadSegmentState | null => {
    const segment = toSafeThreadAttachmentSegment(threadId);
    if (!segment) return null;
    let state = states.get(segment);
    if (!state) {
      state = { hasReadModelThread: false, allDeleted: true, hasLiveSession: false };
      states.set(segment, state);
    }
    return state;
  };

  for (const thread of threads) {
    const state = stateFor(thread.id);
    if (!state) continue;
    state.hasReadModelThread = true;
    if (thread.deletedAt === null) state.allDeleted = false;
  }
  for (const threadId of liveThreadIds) {
    const state = stateFor(threadId);
    if (state) state.hasLiveSession = true;
  }
  return states;
}

function isProtectedHead(
  file: FileState,
  nowMs: number,
  segments: Map<string, ThreadSegmentState>,
) {
  if (file.isSharedHead) return true;
  return (
    !file.isRotation &&
    (file.mtimeMs > nowMs - HEAD_QUIET_PERIOD_MS ||
      segments.get(file.threadSegment ?? "")?.hasLiveSession === true)
  );
}

function getValidRetentionDays(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function getValidSizeCapBytes(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value * MB : null;
}

export interface ProviderLogPlanInput {
  readonly providerLogsDir: string;
  readonly threads: ReadonlyArray<ProviderLogRetentionThread>;
  readonly liveThreadIds: ReadonlySet<string>;
  readonly retentionDays: number | null;
  readonly maxTotalMb: number | null;
  readonly nowMs?: number;
}

export interface PlannedProviderLogRemoval {
  readonly filePath: string;
  readonly name: string;
  readonly threadSegment: string | null;
  readonly isRotation: boolean;
  readonly isSharedHead: boolean;
  readonly size: number;
  readonly mtimeMs: number;
  readonly reason: RemovalReason;
}

export interface ProviderLogCleanupPlan {
  readonly scannedFiles: number;
  readonly failedFiles: number;
  readonly totalBytes: number;
  /** Removals in execution order: identity, then age, then oldest-first size cap. */
  readonly removals: ReadonlyArray<PlannedProviderLogRemoval>;
}

export interface ProviderLogExecuteInput {
  readonly removals: ReadonlyArray<PlannedProviderLogRemoval>;
  /** Fresh at execution time, so a thread that went live keeps its head. */
  readonly threads: ReadonlyArray<ProviderLogRetentionThread>;
  readonly liveThreadIds: ReadonlySet<string>;
  readonly retentionDays: number | null;
  readonly nowMs?: number;
  /** Injectable only to exercise per-file filesystem failure handling. */
  readonly unlink?: (filePath: string) => Promise<void>;
}

/**
 * Decide which recognized provider log files the policy would remove. Reads
 * directory metadata only; the read model and session list are caller snapshots.
 */
export async function planProviderLogCleanup(
  input: ProviderLogPlanInput,
): Promise<ProviderLogCleanupPlan> {
  const nowMs = input.nowMs ?? Date.now();
  const retentionDays = getValidRetentionDays(input.retentionDays);
  const retentionCutoff = retentionDays === null ? null : nowMs - retentionDays * DAY_MS;
  const sizeCapBytes = getValidSizeCapBytes(input.maxTotalMb);
  const segments = buildThreadSegmentStates(input.threads, input.liveThreadIds);
  let scannedFiles = 0;
  let failedFiles = 0;

  let entries;
  try {
    entries = await fs.readdir(input.providerLogsDir, { withFileTypes: true });
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { scannedFiles, failedFiles: missing ? 0 : 1, totalBytes: 0, removals: [] };
  }

  const remaining = new Map<string, FileState>();
  const candidates = entries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    const file = classifyLogFile(entry.name, input.providerLogsDir);
    return file ? [file] : [];
  });
  await forEachConcurrent(candidates, async (candidate) => {
    try {
      const stat = await fs.stat(candidate.filePath);
      if (!stat.isFile()) return;
      remaining.set(candidate.filePath, { ...candidate, size: stat.size, mtimeMs: stat.mtimeMs });
      scannedFiles += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failedFiles += 1;
    }
  });
  const totalBytes = [...remaining.values()].reduce((total, file) => total + file.size, 0);

  const removals: PlannedProviderLogRemoval[] = [];
  const take = (file: FileState, reason: RemovalReason) => {
    if (isProtectedHead(file, nowMs, segments)) return;
    remaining.delete(file.filePath);
    removals.push({ ...file, reason });
  };
  const sorted = [...remaining.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const file of sorted) {
    if (file.threadSegment !== null && segments.get(file.threadSegment)?.allDeleted === true) {
      take(file, "deletedThreads");
    }
  }
  for (const file of sorted) {
    if (file.threadSegment !== null && !segments.has(file.threadSegment)) {
      take(file, "unknownThreads");
    }
  }
  if (retentionCutoff !== null) {
    for (const file of [...remaining.values()]) {
      if (file.mtimeMs < retentionCutoff) take(file, "age");
    }
  }
  if (sizeCapBytes !== null) {
    let projectedBytes = [...remaining.values()].reduce((total, file) => total + file.size, 0);
    const sizeCandidates = [...remaining.values()]
      .filter((file) => !isProtectedHead(file, nowMs, segments))
      .toSorted(
        (left, right) =>
          Number(left.isRotation === false) - Number(right.isRotation === false) ||
          left.mtimeMs - right.mtimeMs ||
          left.name.localeCompare(right.name),
      );
    for (const file of sizeCandidates) {
      if (projectedBytes <= sizeCapBytes) break;
      take(file, "sizeCap");
      projectedBytes -= file.size;
    }
  }
  return { scannedFiles, failedFiles, totalBytes, removals };
}

/**
 * Remove planned files, re-checking each one first: a head that became live or
 * recent is kept, and an age removal is skipped if the file was written since.
 */
export async function executeProviderLogCleanup(
  input: ProviderLogExecuteInput,
): Promise<{
  readonly removed: Readonly<
    Record<RemovalReason, { readonly files: number; readonly bytes: number }>
  >;
  readonly failedFiles: number;
  readonly skipped: ReadonlyArray<{ readonly filePath: string; readonly reason: string }>;
}> {
  const removed = emptyRemovalCounts();
  const skipped: Array<{ filePath: string; reason: string }> = [];
  let failedFiles = 0;
  const nowMs = input.nowMs ?? Date.now();
  const retentionDays = getValidRetentionDays(input.retentionDays);
  const retentionCutoff = retentionDays === null ? null : nowMs - retentionDays * DAY_MS;
  const segments = buildThreadSegmentStates(input.threads, input.liveThreadIds);
  const unlink = input.unlink ?? ((filePath: string) => fs.unlink(filePath));

  await forEachConcurrent(input.removals, async (file) => {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(file.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failedFiles += 1;
      return;
    }
    if (!stat.isFile()) return;
    const fresh = { ...file, size: stat.size, mtimeMs: stat.mtimeMs };
    if (isProtectedHead(fresh, nowMs, segments)) {
      skipped.push({ filePath: file.filePath, reason: "log head is live or recently written" });
      return;
    }
    if (file.reason === "age" && (retentionCutoff === null || stat.mtimeMs >= retentionCutoff)) {
      skipped.push({ filePath: file.filePath, reason: "log was written since the plan" });
      return;
    }
    try {
      await unlink(file.filePath);
      removed[file.reason].files += 1;
      removed[file.reason].bytes += stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failedFiles += 1;
    }
  });
  return { removed, failedFiles, skipped };
}

/** Plan and immediately execute one sweep. */
export async function sweepProviderLogs(
  input: ProviderLogSweepInput,
): Promise<ProviderLogSweepSummary> {
  const nowMs = input.nowMs ?? Date.now();
  const plan = await planProviderLogCleanup({ ...input, nowMs });
  const result = await executeProviderLogCleanup({
    removals: plan.removals,
    threads: input.threads,
    liveThreadIds: input.liveThreadIds,
    retentionDays: input.retentionDays,
    nowMs,
    ...(input.unlink ? { unlink: input.unlink } : {}),
  });
  const removedBytes = Object.values(result.removed).reduce((total, r) => total + r.bytes, 0);
  return {
    scannedFiles: plan.scannedFiles,
    removed: result.removed,
    failedFiles: plan.failedFiles + result.failedFiles,
    remainingBytes: plan.totalBytes - removedBytes,
  };
}
