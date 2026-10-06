import { RotatingFileSink } from "@t3tools/shared/logging";
import { Effect } from "effect";

import type { TraceRecord } from "./TraceRecord.ts";

const FLUSH_BUFFER_THRESHOLD = 32;
const SQL_TRACE_SAMPLE_RATE = 0.1;

function shouldPersistTraceRecord(record: TraceRecord): boolean {
  const isSqlSpan =
    typeof record.attributes["db.system.name"] === "string" || /^sql\./i.test(record.name);
  if (!isSqlSpan) return true;

  const isFailure =
    record.type === "effect-span"
      ? record.exit._tag !== "Success"
      : record.status?.code === "2" || record.status?.message !== undefined;
  if (isFailure) return true;

  // Trace/span ids are stable random identifiers, so deterministic head
  // sampling retains a consistent 10% of successful SQL spans without
  // coupling the decision to request ordering or adding mutable sampler state.
  let hash = 2166136261;
  for (const character of `${record.traceId}:${record.spanId}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x1_0000_0000 < SQL_TRACE_SAMPLE_RATE;
}

export interface TraceSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
}

export interface TraceSink {
  readonly filePath: string;
  push: (record: TraceRecord) => void;
  flush: Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export const makeTraceSink = Effect.fn("makeTraceSink")(function* (options: TraceSinkOptions) {
  const sink = new RotatingFileSink({
    filePath: options.filePath,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
  });

  let buffer: Array<string> = [];

  const flushUnsafe = () => {
    if (buffer.length === 0) {
      return;
    }

    const chunk = buffer.join("");
    buffer = [];

    try {
      sink.write(chunk);
    } catch {
      buffer.unshift(chunk);
    }
  };

  const flush = Effect.sync(flushUnsafe).pipe(Effect.withTracerEnabled(false));

  yield* Effect.addFinalizer(() => flush.pipe(Effect.ignore));
  yield* Effect.forkScoped(
    Effect.sleep(`${options.batchWindowMs} millis`).pipe(Effect.andThen(flush), Effect.forever),
  );

  return {
    filePath: options.filePath,
    push(record) {
      if (!shouldPersistTraceRecord(record)) return;
      try {
        buffer.push(`${JSON.stringify(record)}\n`);
        if (buffer.length >= FLUSH_BUFFER_THRESHOLD) {
          flushUnsafe();
        }
      } catch {
        return;
      }
    },
    flush,
    close: () => flush,
  } satisfies TraceSink;
});
