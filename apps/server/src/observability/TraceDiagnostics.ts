import fs from "node:fs/promises";
import path from "node:path";

import type {
  ServerTraceDiagnosticsErrorKind,
  ServerTraceDiagnosticsResult,
} from "@t3tools/contracts";
import { DateTime, Option } from "effect";

import { traceRecordExitTag } from "./TraceRecord.ts";

const TOP_SPANS_LIMIT = 10;
const SLOWEST_SPANS_LIMIT = 10;
const COMMON_FAILURES_LIMIT = 10;
const LATEST_FAILURES_LIMIT = 10;
const LOG_EVENT_LIMIT = 20;
// Oversized accumulator bound; trimming to the limit is amortized rather than
// sorting every occurrence.
const TRIM_FACTOR = 4;
const DEFAULT_SLOW_SPAN_THRESHOLD_MS = 1_000;
const CAUSE_SUMMARY_MAX_CHARS = 200;

export type TraceDiagnosticsError = {
  readonly kind: ServerTraceDiagnosticsErrorKind;
  readonly message: string;
};

export interface TraceDiagnosticsSummary {
  readonly traceFilePath: string;
  readonly scannedFilePaths: ReadonlyArray<string>;
  readonly readAt: string;
  readonly recordCount: number;
  readonly parseErrorCount: number;
  readonly firstSpanAt: string | null;
  readonly lastSpanAt: string | null;
  readonly failureCount: number;
  readonly interruptionCount: number;
  readonly slowSpanThresholdMs: number;
  readonly slowSpanCount: number;
  readonly logLevelCounts: Readonly<Record<string, number>>;
  readonly topSpansByCount: ReadonlyArray<TraceSpanSummary>;
  readonly slowestSpans: ReadonlyArray<TraceSpanOccurrence>;
  readonly commonFailures: ReadonlyArray<TraceFailureSummary>;
  readonly latestFailures: ReadonlyArray<TraceFailureOccurrence>;
  readonly latestWarningAndErrorLogs: ReadonlyArray<TraceLogEvent>;
  readonly partialFailure: boolean | null;
  readonly error: TraceDiagnosticsError | null;
  /** Retention, sampling, and parse caveats a zero counter cannot express. */
  readonly notes: ReadonlyArray<string>;
}

export interface TraceSpanSummary {
  readonly name: string;
  readonly count: number;
  readonly failureCount: number;
  readonly totalDurationMs: number;
  readonly averageDurationMs: number;
  readonly maxDurationMs: number;
}

export interface TraceSpanOccurrence {
  readonly name: string;
  readonly durationMs: number;
  readonly endedAt: string;
  readonly traceId: string;
  readonly spanId: string;
}

export interface TraceFailureSummary {
  readonly name: string;
  readonly cause: string;
  readonly count: number;
  readonly lastSeenAt: string;
  readonly traceId: string;
  readonly spanId: string;
}

export type TraceFailureOccurrence = TraceSpanOccurrence & { readonly cause: string };

export interface TraceLogEvent {
  readonly spanName: string;
  readonly level: string;
  readonly message: string;
  readonly seenAt: string;
  readonly traceId: string;
  readonly spanId: string;
}

interface MutableFailureSummary {
  name: string;
  cause: string;
  count: number;
  lastSeenAt: string;
  traceId: string;
  spanId: string;
}

const LOG_LEVEL_WARNING_OR_ERROR = new Set(["WARN", "WARNING", "ERROR", "FATAL"]);

function emptySummary(
  traceFilePath: string,
  readAt: string,
  slowSpanThresholdMs: number,
): TraceDiagnosticsSummary {
  return {
    traceFilePath,
    scannedFilePaths: [],
    readAt,
    recordCount: 0,
    parseErrorCount: 0,
    firstSpanAt: null,
    lastSpanAt: null,
    failureCount: 0,
    interruptionCount: 0,
    slowSpanThresholdMs,
    slowSpanCount: 0,
    logLevelCounts: {},
    topSpansByCount: [],
    slowestSpans: [],
    commonFailures: [],
    latestFailures: [],
    latestWarningAndErrorLogs: [],
    partialFailure: null,
    error: null,
    notes: [],
  };
}

/**
 * Rotation names are `<filePath>.<n>` with n ascending toward older files
 * (packages/shared/src/logging.ts). Returned oldest-first so reported timings
 * follow retention order.
 */
function rotationIndexesOf(filePath: string, entryNames: ReadonlyArray<string>): Array<number> {
  const baseName = path.basename(filePath);
  const pattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)$`);
  const indexes: Array<number> = [];
  for (const entry of entryNames) {
    const match = pattern.exec(entry);
    if (match) indexes.push(Number(match[1]));
  }
  return indexes.toSorted((left, right) => right - left);
}

async function existingTraceFilePaths(traceFilePath: string): Promise<Array<string>> {
  const directory = path.dirname(traceFilePath);
  const baseName = path.basename(traceFilePath);
  let entryNames: ReadonlyArray<string>;
  try {
    entryNames = await fs.readdir(directory);
  } catch {
    return [];
  }
  if (!entryNames.includes(baseName)) return [];
  return [
    ...rotationIndexesOf(traceFilePath, entryNames).map((index) => `${traceFilePath}.${index}`),
    traceFilePath,
  ];
}

function trimTop<T>(entries: Array<T>, limit: number, compare: (left: T, right: T) => number): T[] {
  if (entries.length > limit * TRIM_FACTOR) {
    entries.sort(compare);
    entries.length = limit;
  }
  return entries;
}

function byDurationDesc(left: TraceSpanOccurrence, right: TraceSpanOccurrence): number {
  return right.durationMs - left.durationMs;
}

function byEndedAtDesc(
  left: { readonly endedAt: string },
  right: { readonly endedAt: string },
): number {
  return right.endedAt.localeCompare(left.endedAt);
}

function bySeenAtDesc(left: TraceLogEvent, right: TraceLogEvent): number {
  return right.seenAt.localeCompare(left.seenAt);
}

function toNanos(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    const nanos = BigInt(value);
    return nanos > 0n ? nanos : null;
  } catch {
    return null;
  }
}

function nanosToIso(nanos: bigint): string {
  return new Date(Number(nanos / 1_000_000n)).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function failureCause(record: Record<string, unknown>): string {
  if (record.type === "effect-span" && isRecord(record.exit)) {
    const cause = record.exit.cause;
    if (typeof cause === "string" && cause.length > 0) {
      return cause.length > CAUSE_SUMMARY_MAX_CHARS
        ? `${cause.slice(0, CAUSE_SUMMARY_MAX_CHARS - 1)}…`
        : cause;
    }
  }
  if (isRecord(record.status)) {
    const message = record.status.message;
    if (typeof message === "string" && message.length > 0) {
      return message.length > CAUSE_SUMMARY_MAX_CHARS
        ? `${message.slice(0, CAUSE_SUMMARY_MAX_CHARS - 1)}…`
        : message;
    }
  }
  return "unknown cause";
}

/**
 * Reads retained trace files from disk. Pure filesystem work with no Effect
 * services so a stopped server can still be diagnosed, which is the only time
 * the retained files are usually worth reading.
 */
export async function summarizeTraceDiagnostics(input: {
  readonly traceFilePaths: ReadonlyArray<string>;
  readonly slowSpanThresholdMs?: number;
  readonly now?: Date;
}): Promise<TraceDiagnosticsSummary> {
  const slowSpanThresholdMs = input.slowSpanThresholdMs ?? DEFAULT_SLOW_SPAN_THRESHOLD_MS;
  const readAt = (input.now ?? new Date()).toISOString();
  const primary = input.traceFilePaths[0] ?? "";

  const discovered: Array<Array<string>> = [];
  for (const candidate of input.traceFilePaths) {
    discovered.push(await existingTraceFilePaths(candidate));
  }
  const scannedFilePaths = discovered.flat();
  const notes: Array<string> = [];

  if (scannedFilePaths.length === 0) {
    return {
      ...emptySummary(primary, readAt, slowSpanThresholdMs),
      error: {
        kind: "trace-file-not-found",
        message: `No trace file found. Checked: ${input.traceFilePaths.join(", ")}`,
      },
      notes,
    };
  }

  const spansByName = new Map<
    string,
    { count: number; failureCount: number; timedCount: number; total: number; max: number }
  >();
  const failuresByCause = new Map<string, MutableFailureSummary>();
  const slowestSpans: Array<TraceSpanOccurrence> = [];
  const latestFailures: Array<TraceFailureOccurrence> = [];
  const logEvents: Array<TraceLogEvent> = [];
  const logLevelCounts: Record<string, number> = {};

  let recordCount = 0;
  let parseErrorCount = 0;
  let failureCount = 0;
  let interruptionCount = 0;
  let slowSpanCount = 0;
  let firstSpanAt: string | null = null;
  let lastSpanAt: string | null = null;
  let unreadableFileCount = 0;
  let untimedRecordCount = 0;

  for (const filePath of scannedFilePaths) {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      unreadableFileCount += 1;
      parseErrorCount += 1;
      notes.push(
        `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parseErrorCount += 1;
        continue;
      }
      if (!isRecord(parsed) || typeof parsed.name !== "string") {
        parseErrorCount += 1;
        continue;
      }

      recordCount += 1;
      const name = parsed.name;
      const traceId = readString(parsed.traceId, "unknown");
      const spanId = readString(parsed.spanId, "unknown");
      const exitTag = traceRecordExitTag(parsed);

      // Spans the tracer never started carry startTimeUnixNano "0", which makes
      // the recorded duration a difference against the epoch. Reporting those as
      // slow spans would be fabricated timing, so they are counted but excluded
      // from every duration-derived aggregate.
      const startNanos = toNanos(parsed.startTimeUnixNano);
      const endNanos = toNanos(parsed.endTimeUnixNano);
      const hasDuration = startNanos !== null && endNanos !== null && endNanos >= startNanos;
      if (!hasDuration) untimedRecordCount += 1;
      const durationMs = hasDuration ? Number(endNanos - startNanos) / 1_000_000 : 0;
      const startedAt = startNanos === null ? null : nanosToIso(startNanos);
      const endedAt = endNanos === null ? readAt : nanosToIso(endNanos);

      if (startedAt !== null && (firstSpanAt === null || startedAt < firstSpanAt)) {
        firstSpanAt = startedAt;
      }
      if (startedAt !== null && (lastSpanAt === null || startedAt > lastSpanAt)) {
        lastSpanAt = startedAt;
      }

      const spanSummary = spansByName.get(name) ?? {
        count: 0,
        failureCount: 0,
        timedCount: 0,
        total: 0,
        max: 0,
      };
      spanSummary.count += 1;
      if (hasDuration) {
        spanSummary.timedCount += 1;
        spanSummary.total += durationMs;
        spanSummary.max = Math.max(spanSummary.max, durationMs);
      }
      if (exitTag === "Failure") spanSummary.failureCount += 1;
      spansByName.set(name, spanSummary);

      if (hasDuration && durationMs > slowSpanThresholdMs) {
        slowSpanCount += 1;
        slowestSpans.push({ name, durationMs, endedAt, traceId, spanId });
        trimTop(slowestSpans, SLOWEST_SPANS_LIMIT, byDurationDesc);
      }

      if (exitTag === "Failure" || exitTag === "Interrupted") {
        const seenAt = endedAt ?? readAt;
        if (exitTag === "Failure") failureCount += 1;
        else interruptionCount += 1;

        const cause = failureCause(parsed);
        const failureKey = `${name} ${cause}`;
        const existing = failuresByCause.get(failureKey);
        if (existing === undefined) {
          failuresByCause.set(failureKey, {
            name,
            cause,
            count: 1,
            lastSeenAt: seenAt,
            traceId,
            spanId,
          });
        } else {
          existing.count += 1;
          if (seenAt > existing.lastSeenAt) {
            existing.lastSeenAt = seenAt;
            existing.traceId = traceId;
            existing.spanId = spanId;
          }
        }

        latestFailures.push({
          name,
          cause,
          durationMs,
          endedAt: seenAt,
          traceId,
          spanId,
        });
        trimTop(latestFailures, LATEST_FAILURES_LIMIT, byEndedAtDesc);
      }

      if (Array.isArray(parsed.events)) {
        for (const rawEvent of parsed.events) {
          if (!isRecord(rawEvent) || !isRecord(rawEvent.attributes)) continue;
          const level = rawEvent.attributes["effect.logLevel"];
          if (typeof level !== "string") continue;
          logLevelCounts[level] = (logLevelCounts[level] ?? 0) + 1;
          if (!LOG_LEVEL_WARNING_OR_ERROR.has(level.toUpperCase())) continue;
          logEvents.push({
            spanName: name,
            level,
            message: readString(rawEvent.name, ""),
            seenAt:
              toNanos(rawEvent.timeUnixNano) === null
                ? readAt
                : nanosToIso(toNanos(rawEvent.timeUnixNano)!),
            traceId,
            spanId,
          });
          trimTop(logEvents, LOG_EVENT_LIMIT, bySeenAtDesc);
        }
      }
    }
  }

  if (untimedRecordCount > 0) {
    notes.push(
      `${untimedRecordCount} record(s) have no usable span start time; they are counted but excluded from span timings, so duration counts understate the file.`,
    );
  }
  if (parseErrorCount > 0) {
    notes.push(
      `${parseErrorCount} line(s) could not be read as a trace record; counts below understate the file.`,
    );
  }
  notes.push(
    `Scanned ${scannedFilePaths.length} retained trace file(s). Rotation keeps a bounded window, so spans older than the oldest retained file are not represented.`,
  );
  notes.push(
    "Successful sql.* spans are head-sampled at roughly 10% by the trace sink (TraceSink.ts), so SQL span counts understate the real query volume.",
  );

  return {
    // The head of the newest retained series actually read, which is not the
    // first candidate path when only another flavour (dev vs userdata) exists.
    traceFilePath: scannedFilePaths.at(-1) ?? primary,
    scannedFilePaths,
    readAt,
    recordCount,
    parseErrorCount,
    firstSpanAt,
    lastSpanAt,
    failureCount,
    interruptionCount,
    slowSpanThresholdMs,
    slowSpanCount,
    logLevelCounts,
    topSpansByCount: [...spansByName.entries()]
      .map(([name, entry]) => ({
        name,
        count: entry.count,
        failureCount: entry.failureCount,
        totalDurationMs: entry.total,
        averageDurationMs: entry.timedCount === 0 ? 0 : entry.total / entry.timedCount,
        maxDurationMs: entry.max,
      }))
      .toSorted((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .slice(0, TOP_SPANS_LIMIT),
    slowestSpans: [...slowestSpans].sort(byDurationDesc).slice(0, SLOWEST_SPANS_LIMIT),
    commonFailures: [...failuresByCause.values()]
      .toSorted((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .slice(0, COMMON_FAILURES_LIMIT),
    latestFailures: [...latestFailures].sort(byEndedAtDesc).slice(0, LATEST_FAILURES_LIMIT),
    latestWarningAndErrorLogs: [...logEvents].sort(bySeenAtDesc).slice(0, LOG_EVENT_LIMIT),
    partialFailure: parseErrorCount > 0 || unreadableFileCount > 0 ? true : null,
    error: null,
    notes,
  };
}
const optionalUtc = (iso: string | null): Option.Option<DateTime.Utc> =>
  iso === null ? Option.none() : Option.some(DateTime.makeUnsafe(iso));

const utcIso = (value: DateTime.Utc): string => new Date(value.epochMilliseconds).toISOString();

/**
 * Adapts the JSON-safe summary to the RPC result contract, whose `Schema.Option`
 * and `Schema.DateTimeUtc` fields decode into Effect instances. Only the RPC
 * boundary needs those instances; the CLI prints the summary directly so JSON
 * stdout never carries `_tag` internals.
 */
export function toServerTraceDiagnosticsResult(
  summary: TraceDiagnosticsSummary,
): ServerTraceDiagnosticsResult {
  return {
    traceFilePath: summary.traceFilePath,
    scannedFilePaths: summary.scannedFilePaths,
    readAt: DateTime.makeUnsafe(summary.readAt),
    recordCount: summary.recordCount,
    parseErrorCount: summary.parseErrorCount,
    firstSpanAt: optionalUtc(summary.firstSpanAt),
    lastSpanAt: optionalUtc(summary.lastSpanAt),
    failureCount: summary.failureCount,
    interruptionCount: summary.interruptionCount,
    slowSpanThresholdMs: summary.slowSpanThresholdMs,
    slowSpanCount: summary.slowSpanCount,
    logLevelCounts: summary.logLevelCounts,
    topSpansByCount: summary.topSpansByCount,
    slowestSpans: summary.slowestSpans.map((value) => ({
      ...value,
      endedAt: DateTime.makeUnsafe(value.endedAt),
    })),
    commonFailures: summary.commonFailures.map((value) => ({
      ...value,
      lastSeenAt: DateTime.makeUnsafe(value.lastSeenAt),
    })),
    latestFailures: summary.latestFailures.map((value) => ({
      ...value,
      endedAt: DateTime.makeUnsafe(value.endedAt),
    })),
    latestWarningAndErrorLogs: summary.latestWarningAndErrorLogs.map((value) => ({
      ...value,
      seenAt: DateTime.makeUnsafe(value.seenAt),
    })),
    partialFailure:
      summary.partialFailure === null ? Option.none() : Option.some(summary.partialFailure),
    error: summary.error === null ? Option.none() : Option.some(summary.error),
    notes: summary.notes,
  };
}

function utcOrNull(value: Option.Option<DateTime.Utc>): string | null {
  return Option.isSome(value) ? utcIso(value.value) : null;
}

/**
 * Projects an RPC result back onto the JSON-safe summary shape. The CLI prints
 * this rather than the decoded result because `Schema.Option` and
 * `Schema.DateTimeUtc` decode into Effect instances that JSON.stringify renders
 * as `_tag` internals.
 */
export function toPlainTraceDiagnostics(
  result: ServerTraceDiagnosticsResult,
): TraceDiagnosticsSummary {
  return {
    traceFilePath: result.traceFilePath,
    scannedFilePaths: result.scannedFilePaths,
    readAt: utcIso(result.readAt),
    recordCount: result.recordCount,
    parseErrorCount: result.parseErrorCount,
    firstSpanAt: utcOrNull(result.firstSpanAt),
    lastSpanAt: utcOrNull(result.lastSpanAt),
    failureCount: result.failureCount,
    interruptionCount: result.interruptionCount,
    slowSpanThresholdMs: result.slowSpanThresholdMs,
    slowSpanCount: result.slowSpanCount,
    logLevelCounts: result.logLevelCounts,
    topSpansByCount: result.topSpansByCount,
    slowestSpans: result.slowestSpans.map((value) => ({
      ...value,
      endedAt: utcIso(value.endedAt),
    })),
    commonFailures: result.commonFailures.map((value) => ({
      ...value,
      lastSeenAt: utcIso(value.lastSeenAt),
    })),
    latestFailures: result.latestFailures.map((value) => ({
      ...value,
      endedAt: utcIso(value.endedAt),
    })),
    latestWarningAndErrorLogs: result.latestWarningAndErrorLogs.map((value) => ({
      ...value,
      seenAt: utcIso(value.seenAt),
    })),
    partialFailure: Option.getOrNull(result.partialFailure),
    error: Option.getOrNull(result.error),
    notes: result.notes ?? [],
  };
}
