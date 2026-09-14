import { describe, expect, it } from "@effect/vitest";
import {
  PullRequestMonitorFeedbackItemId,
  PullRequestMonitorFeedbackRevisionId,
  ThreadId,
  type PullRequestMonitorFeedbackRevision,
} from "@t3tools/contracts";
import { findingContextTurns, resolveFindingDetail } from "./findingContext.ts";

const revision = (
  body: string,
  version: number | undefined = 1,
): PullRequestMonitorFeedbackRevision => ({
  id: PullRequestMonitorFeedbackRevisionId.make("revision-1"),
  itemId: PullRequestMonitorFeedbackItemId.make("item-1"),
  revisionNumber: 1,
  sourceRevision: "review:abc",
  contentHash: "hash",
  headSha: "abc",
  createdAt: "2026-01-01T00:00:00.000Z",
  summary: "review-finding: [major] Finding",
  payload: {
    finding: { title: "Finding", detail: body, severity: "major" },
    reviewThreadId: ThreadId.make("review"),
    ...(version === undefined ? {} : { contentVersion: version }),
  },
});

describe("immutable finding context", () => {
  it("preserves full bodies and identifies legacy or unavailable content", () => {
    const body = "evidence\n".repeat(1_000);
    expect(resolveFindingDetail(revision(body))).toMatchObject({
      contentStatus: "complete",
      finding: { detail: body },
      reviewedHeadSha: "abc",
    });
    const legacy = revision(body);
    expect(
      resolveFindingDetail({
        ...legacy,
        payload: {
          finding: { title: "Finding", detail: body, severity: "major" },
          reviewThreadId: "review",
        },
      }).contentStatus,
    ).toBe("legacy-potentially-truncated");
    expect(resolveFindingDetail({ ...legacy, payload: {} }).contentStatus).toBe("unavailable");
  });

  it("delivers complete evidence in one replay-stable turn, even above 12,000 characters", () => {
    const body = "evidence \u{1f600}\n".repeat(4_000);
    const source = revision(body);
    const turns = findingContextTurns([source]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text.endsWith(body)).toBe(true);
    expect(turns[0]?.key).toBe("revision-1:complete");
    expect(findingContextTurns([source])).toEqual(turns);
  });
});
