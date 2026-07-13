import { describe, expect, it } from "vitest";
import { CheckpointRef, MessageId, TurnId } from "@t3tools/contracts";
import type { TurnDiffSummary } from "../types";
import { buildDiffCheckpointRevision, resolveSessionDiffRange } from "./useDiffState";

function makeSummary(overrides: Partial<TurnDiffSummary> = {}): TurnDiffSummary {
  return {
    turnId: TurnId.make("turn-1"),
    completedAt: "2026-01-01T00:00:00.000Z",
    status: "speculative",
    files: [],
    turnFiles: [],
    checkpointRef: CheckpointRef.make("provider-diff:event-1"),
    assistantMessageId: MessageId.make("assistant:item-1"),
    checkpointTurnCount: 1,
    speculativePatch: "diff --git a/src/a.ts b/src/a.ts\n+old",
    ...overrides,
  };
}

describe("buildDiffCheckpointRevision", () => {
  it("changes when a speculative patch changes without checkpoint metadata changing", () => {
    const before = buildDiffCheckpointRevision([
      makeSummary({ speculativePatch: "diff --git a/src/a.ts b/src/a.ts\n+old" }),
    ]);
    const after = buildDiffCheckpointRevision([
      makeSummary({ speculativePatch: "diff --git a/src/b.ts b/src/b.ts\n+new" }),
    ]);

    expect(before).not.toBe(after);
  });

  it("does not hash patch text for ready checkpoint revisions", () => {
    const before = buildDiffCheckpointRevision([
      makeSummary({ status: "ready", speculativePatch: "diff --git a/src/a.ts b/src/a.ts\n+old" }),
    ]);
    const after = buildDiffCheckpointRevision([
      makeSummary({ status: "ready", speculativePatch: "diff --git a/src/b.ts b/src/b.ts\n+new" }),
    ]);

    expect(before).toBe(after);
  });
});

describe("resolveSessionDiffRange", () => {
  it("uses only completed turn counts after the current session baseline", () => {
    expect(
      resolveSessionDiffRange({
        sessionStartCheckpointTurnCount: 4,
        inferredCheckpointTurnCountByTurnId: {},
        summaries: [
          makeSummary({ turnId: TurnId.make("old-turn"), checkpointTurnCount: 2 }),
          makeSummary({ turnId: TurnId.make("session-turn-1"), checkpointTurnCount: 5 }),
          makeSummary({ turnId: TurnId.make("session-turn-2"), checkpointTurnCount: 6 }),
        ],
      }),
    ).toEqual({ fromTurnCount: 4, toTurnCount: 6 });
  });

  it("returns null until the current session has a completed checkpoint", () => {
    expect(
      resolveSessionDiffRange({
        sessionStartCheckpointTurnCount: 4,
        inferredCheckpointTurnCountByTurnId: {},
        summaries: [makeSummary({ turnId: TurnId.make("old-turn"), checkpointTurnCount: 3 })],
      }),
    ).toBeNull();
  });

  it("uses inferred checkpoint counts when persisted checkpoint metadata is missing", () => {
    expect(
      resolveSessionDiffRange({
        sessionStartCheckpointTurnCount: 1,
        inferredCheckpointTurnCountByTurnId: { [TurnId.make("turn-with-inferred-count")]: 2 },
        summaries: [
          makeSummary({
            turnId: TurnId.make("turn-with-inferred-count"),
            checkpointTurnCount: undefined,
          }),
        ],
      }),
    ).toEqual({ fromTurnCount: 1, toTurnCount: 2 });
  });
});
