import { MessageId, QueuedTurnId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  childReportDedupeKey,
  classifyChildReport,
  mintDispatch,
  mintDispatchRecord,
  transitionDelegationExecution,
} from "./dispatchAuthority.ts";

const assignmentId = MessageId.make("assignment-1");

function delegation(overrides: {
  readonly dispatchId?: string;
  readonly dispatchSequence?: number;
  readonly dispatchTurnId?: TurnId | null;
  readonly completedAt?: string | null;
}) {
  return {
    assignmentId,
    ...(overrides.dispatchId !== undefined ? { dispatchId: overrides.dispatchId } : {}),
    ...(overrides.dispatchSequence !== undefined
      ? { dispatchSequence: overrides.dispatchSequence }
      : {}),
    ...(overrides.dispatchTurnId !== undefined ? { dispatchTurnId: overrides.dispatchTurnId } : {}),
    followUp: "automatic" as const,
    completedAt: overrides.completedAt ?? null,
  };
}

describe("dispatchAuthority", () => {
  it("mints ordered generations", () => {
    const [firstId, firstSequence] = mintDispatch(null);
    const [secondId, secondSequence] = mintDispatch(firstSequence);
    expect(firstId).not.toBe(secondId);
    expect(firstSequence).toBe(1);
    expect(secondSequence).toBe(2);
    expect(mintDispatchRecord(null)).toMatchObject({
      dispatchSequence: 1,
      dispatchTurnId: null,
    });
  });

  it("accepts pre-fence history on both sides", () => {
    expect(
      classifyChildReport({
        delegation: delegation({}),
        claimedDispatchId: undefined,
        claimedTurnId: undefined,
        kind: "important-update",
      }),
    ).toBe("accepted");
  });

  it("keeps state-changing reports diagnostic until the first turn is bound", () => {
    expect(
      classifyChildReport({
        delegation: delegation({ dispatchId: "d1", dispatchSequence: 1 }),
        claimedDispatchId: undefined,
        claimedTurnId: TurnId.make("turn-a"),
        kind: "important-update",
      }),
    ).toBe("stale");
    expect(
      classifyChildReport({
        delegation: delegation({ dispatchId: "d1", dispatchSequence: 1 }),
        claimedDispatchId: "d1",
        claimedTurnId: TurnId.make("turn-a"),
        kind: "progress",
      }),
    ).toBe("accepted");
  });

  it("fences the unbound replacement window by dispatch before turn", () => {
    // After `thread.dispatch.replace` the new generation is unbound
    // (dispatchTurnId null, sequence 2). The superseded execution's old
    // dispatch must be stale even though it presents a turn.
    const replacement = delegation({
      dispatchId: "d2",
      dispatchSequence: 2,
      dispatchTurnId: null,
    });
    expect(
      classifyChildReport({
        delegation: replacement,
        claimedDispatchId: "d1",
        claimedTurnId: TurnId.make("turn-a"),
        kind: "important-update",
      }),
    ).toBe("stale");
    // Turn-only state-changing reports stay diagnostic-only until the
    // replacement turn binds; progress history remains allowed.
    expect(
      classifyChildReport({
        delegation: replacement,
        claimedDispatchId: undefined,
        claimedTurnId: TurnId.make("turn-a"),
        kind: "important-update",
      }),
    ).toBe("stale");
    expect(
      classifyChildReport({
        delegation: replacement,
        claimedDispatchId: undefined,
        claimedTurnId: TurnId.make("turn-a"),
        kind: "progress",
      }),
    ).toBe("accepted");
    expect(
      classifyChildReport({
        delegation: replacement,
        claimedDispatchId: "d2",
        claimedTurnId: TurnId.make("turn-b"),
        kind: "important-update",
      }),
    ).toBe("stale");
  });

  it("rejects an unminted dispatch claim on legacy work", () => {
    expect(
      classifyChildReport({
        delegation: delegation({}),
        claimedDispatchId: "dX",
        claimedTurnId: undefined,
        kind: "important-update",
      }),
    ).toBe("stale");
  });

  it("accepts the authorized turn, with or without the dispatch echo", () => {
    const fenced = delegation({
      dispatchId: "d1",
      dispatchSequence: 1,
      dispatchTurnId: TurnId.make("turn-a"),
    });
    for (const claimedDispatchId of [undefined, "d1"] as const) {
      expect(
        classifyChildReport({
          delegation: fenced,
          claimedDispatchId,
          claimedTurnId: TurnId.make("turn-a"),
          kind: "decision-needed",
        }),
      ).toBe("accepted");
    }
  });

  it("marks a superseded execution turn as stale", () => {
    expect(
      classifyChildReport({
        delegation: delegation({
          dispatchId: "d2",
          dispatchSequence: 2,
          dispatchTurnId: TurnId.make("turn-b"),
        }),
        claimedDispatchId: "d1",
        claimedTurnId: TurnId.make("turn-a"),
        kind: "important-update",
      }),
    ).toBe("stale");
  });

  it("marks a mismatched dispatch echo on the authorized turn as stale", () => {
    expect(
      classifyChildReport({
        delegation: delegation({
          dispatchId: "d1",
          dispatchSequence: 1,
          dispatchTurnId: TurnId.make("turn-a"),
        }),
        claimedDispatchId: "d2",
        claimedTurnId: TurnId.make("turn-a"),
        kind: "important-update",
      }),
    ).toBe("stale");
  });

  it("requires execution proof for state-changing reports, but keeps progress history", () => {
    const fenced = delegation({
      dispatchId: "d1",
      dispatchSequence: 1,
      dispatchTurnId: TurnId.make("turn-a"),
    });
    expect(
      classifyChildReport({
        delegation: fenced,
        claimedDispatchId: undefined,
        claimedTurnId: undefined,
        kind: "progress",
      }),
    ).toBe("accepted");
    expect(
      classifyChildReport({
        delegation: fenced,
        claimedDispatchId: undefined,
        claimedTurnId: undefined,
        kind: "important-update",
      }),
    ).toBe("stale");
  });

  it("replays the original durable outcome before current authority checks", () => {
    const closed = delegation({
      dispatchId: "d2",
      dispatchSequence: 2,
      dispatchTurnId: TurnId.make("turn-b"),
      completedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(
      classifyChildReport({
        delegation: closed,
        claimedDispatchId: "d2",
        claimedTurnId: TurnId.make("turn-b"),
        kind: "important-update",
        recordedOutcome: "accepted",
      }),
    ).toBe("accepted");
    expect(
      classifyChildReport({
        delegation: closed,
        claimedDispatchId: "d1",
        claimedTurnId: TurnId.make("turn-a"),
        kind: "important-update",
        recordedOutcome: "stale",
      }),
    ).toBe("stale");
  });

  it("keeps the exact legacy key when no dispatch is involved", () => {
    expect(
      childReportDedupeKey({
        childThreadId: ThreadId.make("child"),
        dispatchId: undefined,
        assignmentId: "assignment-1",
        reportId: "r1",
      }),
    ).toBe("report:child:assignment-1:r1");
    const fenced = childReportDedupeKey({
      childThreadId: ThreadId.make("child"),
      dispatchId: "d1",
      assignmentId: "assignment-1",
      reportId: "r1",
    });
    expect(fenced).toBe("report:child:d1:assignment-1:r1");
    expect(
      childReportDedupeKey({
        childThreadId: "child",
        dispatchId: "d1",
        assignmentId: "assignment-1",
        reportId: "r1",
      }),
    ).toBe(fenced);
    expect(
      childReportDedupeKey({
        childThreadId: "child",
        dispatchId: undefined,
        originTurnId: "turn-a",
        assignmentId: "assignment-1",
        reportId: "r1",
      }),
    ).toBe("report:child:turn:turn-a:assignment-1:r1");
  });

  it("retires execution-scoped decisions and pending answers on replacement", () => {
    const current = {
      ...delegation({
        dispatchId: "d1",
        dispatchSequence: 1,
        dispatchTurnId: TurnId.make("turn-a"),
      }),
      decision: {
        id: "decision-a",
        childThreadId: ThreadId.make("child"),
        childTitle: "Child",
        assignmentId,
        dispatchId: "d1",
        kind: "decision-needed" as const,
        summary: "Choose",
      },
      pendingResponse: {
        queuedTurnId: QueuedTurnId.make("answer-a"),
        report: {
          id: "decision-a",
          childThreadId: ThreadId.make("child"),
          childTitle: "Child",
          assignmentId,
          dispatchId: "d1",
          kind: "decision-needed" as const,
          summary: "Choose",
        },
      },
    };
    const replacement = transitionDelegationExecution(current, "replaced");
    expect(replacement.delegation).toMatchObject({
      previousDispatchId: "d1",
      dispatchReason: "replaced",
      dispatchTurnId: null,
      decision: null,
      pendingResponse: null,
    });
    expect(replacement.delegation.dispatchId).not.toBe("d1");
    expect(replacement.retiredPendingResponseQueuedTurnId).toBe("answer-a");
  });
});
