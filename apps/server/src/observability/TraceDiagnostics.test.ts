import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "vitest";

import {
  summarizeTraceDiagnostics,
  toPlainTraceDiagnostics,
  toServerTraceDiagnosticsResult,
} from "./TraceDiagnostics.ts";

function span(input: {
  readonly name: string;
  readonly startNanos?: bigint;
  readonly durationMs?: number;
  readonly exit?: { readonly _tag: "Success" | "Interrupted" | "Failure"; readonly cause?: string };
  readonly events?: ReadonlyArray<{ readonly name: string; readonly level?: string }>;
}) {
  const start = input.startNanos ?? 1_700_000_000_000_000_000n;
  return {
    type: "effect-span",
    name: input.name,
    kind: "internal",
    traceId: `trace-${input.name}`,
    spanId: `span-${input.name}`,
    sampled: true,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + BigInt((input.durationMs ?? 1) * 1_000_000)),
    durationMs: input.durationMs ?? 1,
    attributes: {},
    events: (input.events ?? []).map((event, index) => ({
      name: event.name,
      timeUnixNano: String(start + BigInt(index)),
      attributes: event.level ? { "effect.logLevel": event.level } : {},
    })),
    links: [],
    exit: input.exit ?? { _tag: "Success" },
  };
}

function makeTraceDir(): { readonly dir: string; readonly traceFilePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "t3-trace-diagnostics-"));
  mkdirSync(join(dir, "logs"), { recursive: true });
  return { dir, traceFilePath: join(dir, "logs", "server.trace.ndjson") };
}

describe("summarizeTraceDiagnostics", () => {
  it("reads the head file and its rotations", async () => {
    const { dir, traceFilePath } = makeTraceDir();
    try {
      writeFileSync(
        traceFilePath,
        `${JSON.stringify(span({ name: "current.span", startNanos: 3_000n }))}\n`,
      );
      writeFileSync(
        `${traceFilePath}.1`,
        `${JSON.stringify(span({ name: "rotated.span", startNanos: 2_000n }))}\n`,
      );

      const summary = await summarizeTraceDiagnostics({ traceFilePaths: [traceFilePath] });

      assert.equal(summary.recordCount, 2);
      assert.deepEqual(summary.scannedFilePaths, [`${traceFilePath}.1`, traceFilePath]);
      assert.equal(
        summary.topSpansByCount.find((entry) => entry.name === "rotated.span")?.count,
        1,
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("counts failures, interruptions, slow spans, and warn/error log events", async () => {
    const { dir, traceFilePath } = makeTraceDir();
    try {
      writeFileSync(
        traceFilePath,
        [
          JSON.stringify(
            span({
              name: "failing.span",
              exit: { _tag: "Failure", cause: "boom" },
              events: [{ name: "span failed", level: "ERROR" }],
            }),
          ),
          JSON.stringify(
            span({
              name: "cancelled.span",
              exit: { _tag: "Interrupted", cause: "interrupted" },
              events: [{ name: "info line" }, { name: "slow line", level: "WARN" }],
            }),
          ),
          JSON.stringify(span({ name: "slow.span", durationMs: 5_000 })),
          "",
        ].join("\n"),
      );

      const summary = await summarizeTraceDiagnostics({
        traceFilePaths: [traceFilePath],
        slowSpanThresholdMs: 1_000,
      });

      assert.equal(summary.failureCount, 1);
      assert.equal(summary.interruptionCount, 1);
      assert.equal(summary.slowSpanCount, 1);
      assert.equal(summary.slowestSpans[0]?.name, "slow.span");
      assert.equal(summary.slowestSpans[0]?.durationMs, 5_000);
      assert.deepEqual(summary.logLevelCounts, { ERROR: 1, WARN: 1 });
      assert.equal(summary.latestWarningAndErrorLogs.length, 2);
      assert.deepEqual(
        summary.commonFailures.map((entry) => `${entry.name}:${entry.cause}`).toSorted(),
        ["cancelled.span:interrupted", "failing.span:boom"],
      );
      assert.deepEqual(summary.latestFailures.map((entry) => entry.name).toSorted(), [
        "cancelled.span",
        "failing.span",
      ]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("reports parse gaps instead of silently counting zero", async () => {
    const { dir, traceFilePath } = makeTraceDir();
    try {
      writeFileSync(
        traceFilePath,
        `{"type":"effect-span","name":"ok.span","durationMs":1}\nnot-json\n{"name":123}\n`,
      );

      const summary = await summarizeTraceDiagnostics({ traceFilePaths: [traceFilePath] });

      assert.equal(summary.recordCount, 1);
      assert.equal(summary.parseErrorCount, 2);
      assert.equal(summary.partialFailure, true);
      assert.isTrue(summary.notes.some((note) => note.includes("could not be read")));
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("reports a missing trace file instead of an empty healthy snapshot", async () => {
    const { dir, traceFilePath } = makeTraceDir();
    try {
      const summary = await summarizeTraceDiagnostics({ traceFilePaths: [traceFilePath] });

      assert.equal(summary.recordCount, 0);
      assert.equal(summary.error?.kind, "trace-file-not-found");
      assert.isTrue((summary.error?.message ?? "").includes(traceFilePath));
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("counts records with no span start time without inventing their duration", async () => {
    const { dir, traceFilePath } = makeTraceDir();
    try {
      // Real trace files contain spans the tracer never started, recorded with
      // startTimeUnixNano "0"; their duration is a difference against the epoch.
      writeFileSync(
        traceFilePath,
        `${JSON.stringify({ ...span({ name: "untimed.span" }), startTimeUnixNano: "0" })}\n${JSON.stringify(span({ name: "timed.span", durationMs: 5 }))}\n`,
      );

      const summary = await summarizeTraceDiagnostics({
        traceFilePaths: [traceFilePath],
        slowSpanThresholdMs: 1_000,
      });

      assert.equal(summary.recordCount, 2);
      assert.equal(summary.slowSpanCount, 0);
      assert.equal(summary.slowestSpans.length, 0);
      assert.isNotNull(summary.firstSpanAt);
      assert.isTrue(summary.notes.some((note) => note.includes("no usable span start time")));
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("keeps Effect internals out of JSON after the RPC round trip", async () => {
    const { dir, traceFilePath } = makeTraceDir();
    try {
      writeFileSync(
        traceFilePath,
        `${JSON.stringify(
          span({ name: "round.trip", exit: { _tag: "Failure", cause: "nope" } }),
        )}\n`,
      );

      const summary = await summarizeTraceDiagnostics({ traceFilePaths: [traceFilePath] });
      const rpcResult = toServerTraceDiagnosticsResult(summary);
      // The contract's Schema.Option/Schema.DateTimeUtc decode into Effect values,
      // which is exactly why the CLI cannot print the decoded result directly.
      assert.include(JSON.stringify(rpcResult), "_tag");

      const json = JSON.stringify(toPlainTraceDiagnostics(rpcResult));
      assert.notInclude(json, "_tag");
      const plain = JSON.parse(json) as Record<string, unknown>;
      assert.equal(plain.recordCount, 1);
      assert.equal(plain.failureCount, 1);
      assert.equal(typeof plain.firstSpanAt, "string");
      assert.equal(plain.partialFailure, null);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
