import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { childReportDedupeKey, classifyChildReport } from "./dispatchAuthority.ts";

const assignmentId = MessageId.make("assignment-1");

function delegation(overrides: {
  readonly dispatchId?: string;
  readonly completedAt?: string | null;
}) {
  return {
    assignmentId,
    ...(overrides.dispatchId !== undefined ? { dispatchId: overrides.dispatchId } : {}),
    followUp: "automatic" as const,
    completedAt: overrides.completedAt ?? null,
  };
}

describe("dispatchAuthority", () => {
  it("accepts legacy reports on legacy delegations", () => {
    expect(classifyChildReport({ delegation: delegation({}), dispatchId: undefined })).toBe(
      "accepted",
    );
  });

  it("accepts a matching dispatch", () => {
    expect(
      classifyChildReport({ delegation: delegation({ dispatchId: "d1" }), dispatchId: "d1" }),
    ).toBe("accepted");
  });

  it("marks a mismatched dispatch as stale", () => {
    expect(
      classifyChildReport({ delegation: delegation({ dispatchId: "d2" }), dispatchId: "d1" }),
    ).toBe("stale");
  });

  it("marks a missing dispatch proof on a fenced delegation as stale", () => {
    expect(
      classifyChildReport({ delegation: delegation({ dispatchId: "d1" }), dispatchId: undefined }),
    ).toBe("stale");
  });

  it("acknowledges reports on completed assignments without a second wake", () => {
    expect(
      classifyChildReport({
        delegation: delegation({ dispatchId: "d1", completedAt: "2026-09-12T00:00:00.000Z" }),
        dispatchId: "d1",
      }),
    ).toBe("already-recorded");
  });

  it("scopes idempotency keys by execution generation", () => {
    const first = childReportDedupeKey({
      childThreadId: "child",
      dispatchId: "d1",
      assignmentId: "assignment-1",
      reportId: "r1",
    });
    const retry = childReportDedupeKey({
      childThreadId: "child",
      dispatchId: "d1",
      assignmentId: "assignment-1",
      reportId: "r1",
    });
    const otherExecution = childReportDedupeKey({
      childThreadId: "child",
      dispatchId: "d2",
      assignmentId: "assignment-1",
      reportId: "r1",
    });
    expect(retry).toBe(first);
    expect(otherExecution).not.toBe(first);
  });
});
