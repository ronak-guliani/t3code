import { describe, expect, it } from "@effect/vitest";
import {
  PullRequestMonitorFeedbackItemId,
  PullRequestMonitorFeedbackRevisionId,
  ThreadId,
  type PullRequestMonitorFeedbackRevision,
} from "@t3tools/contracts";
import { findingContextParts, resolveFindingDetail } from "./findingContext.ts";

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

  it("delivers bounded, ordered, replay-stable parts without losing text", () => {
    const body = "evidence \u{1f600}\n".repeat(4_000);
    const source = revision(body);
    const parts = findingContextParts([source], false);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.text.length < 12_300)).toBe(true);
    const reconstructed = parts
      .map((part) => part.text.slice(part.text.indexOf("\n") + 1))
      .join("");
    expect(reconstructed.endsWith(body)).toBe(true);
    expect(findingContextParts([source], false)).toEqual(parts);
    expect(findingContextParts([source], true)).toEqual([]);
  });
});
