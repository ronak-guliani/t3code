import { MessageId, TurnId, type OrchestrationThread } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  childReportDedupeKey,
  classifyChildReport,
  hasReportReceipt,
  mintDispatch,
  mintDispatchRecord,
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

const noReceipt = false;

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
        hasReceipt: noReceipt,
      }),
    ).toBe("accepted");
  });

  it("accepts a turn running before its first binding", () => {
    expect(
      classifyChildReport({
        delegation: delegation({ dispatchId: "d1" }),
        claimedDispatchId: undefined,
        claimedTurnId: TurnId.make("turn-a"),
        kind: "important-update",
        hasReceipt: noReceipt,
      }),
    ).toBe("accepted");
  });

  it("rejects an unminted dispatch claim on legacy work", () => {
    expect(
      classifyChildReport({
        delegation: delegation({}),
        claimedDispatchId: "dX",
        claimedTurnId: undefined,
        kind: "important-update",
        hasReceipt: noReceipt,
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
          hasReceipt: noReceipt,
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
        hasReceipt: noReceipt,
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
        hasReceipt: noReceipt,
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
        hasReceipt: noReceipt,
      }),
    ).toBe("accepted");
    expect(
      classifyChildReport({
        delegation: fenced,
        claimedDispatchId: undefined,
        claimedTurnId: undefined,
        kind: "important-update",
        hasReceipt: noReceipt,
      }),
    ).toBe("stale");
  });

  it("acknowledges exact duplicates on closed work but fences novel reports", () => {
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
        hasReceipt: true,
      }),
    ).toBe("already-recorded");
    expect(
      classifyChildReport({
        delegation: closed,
        claimedDispatchId: "d1",
        claimedTurnId: TurnId.make("turn-a"),
        kind: "important-update",
        hasReceipt: false,
      }),
    ).toBe("stale");
  });

  it("keeps the exact legacy key when no dispatch is involved", () => {
    expect(
      childReportDedupeKey({
        childThreadId: "child",
        dispatchId: undefined,
        assignmentId: "assignment-1",
        reportId: "r1",
      }),
    ).toBe("report:child:assignment-1:r1");
    const fenced = childReportDedupeKey({
      childThreadId: "child",
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
  });
  it("recovers receipts for exact logical reports only", () => {
    const thread = {
      activities: [
        {
          id: "cmd-1",
          kind: "delegation.reported",
          tone: "info",
          summary: "done",
          payload: { reportId: "r1", assignmentId: "assignment-1", dispatchId: "d1" },
          turnId: null,
          createdAt: "2026-09-12T00:00:00.000Z",
        },
        {
          id: "cmd-legacy",
          kind: "delegation.reported",
          tone: "info",
          summary: "old",
          payload: { reportId: "r0" },
          turnId: null,
          createdAt: "2026-09-12T00:00:00.000Z",
        },
      ],
    } as unknown as OrchestrationThread;
    expect(
      hasReportReceipt(thread, { reportId: "r1", assignmentId: "assignment-1", dispatchId: "d1" }),
    ).toBe(true);
    expect(
      hasReportReceipt(thread, { reportId: "r1", assignmentId: "assignment-1", dispatchId: "d2" }),
    ).toBe(false);
    expect(hasReportReceipt(thread, { reportId: "r0", assignmentId: null, dispatchId: null })).toBe(
      true,
    );
    expect(
      hasReportReceipt(thread, { reportId: "missing", assignmentId: null, dispatchId: null }),
    ).toBe(false);
  });
});
