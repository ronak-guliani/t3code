import { describe, expect, it } from "@effect/vitest";
import type { PullRequestMonitorSnapshot } from "@t3tools/contracts";

import { cursorFromSnapshot, diffPullRequestMonitorSnapshot, emptyCursor } from "./monitorDiff.ts";

function snapshot(overrides: Partial<PullRequestMonitorSnapshot> = {}): PullRequestMonitorSnapshot {
  return {
    provider: "github",
    host: "github.com",
    repository: "acme/app",
    number: 12,
    state: "open",
    isDraft: false,
    headSha: "abc123",
    baseBranch: "main",
    headBranch: "feat",
    mergeability: "mergeable",
    behindBaseBy: 0,
    titleExcerpt: "Add monitor",
    url: "https://github.com/acme/app/pull/12",
    fetchedAt: "2026-08-11T00:00:00.000Z",
    sourceRevision: "rev-1",
    completeness: {
      reviewsComplete: true,
      reviewThreadsComplete: true,
      issueCommentsComplete: true,
      checksComplete: true,
      requiredChecksKnown: true,
    },
    reviews: [],
    reviewThreads: [],
    issueComments: [],
    checkRuns: [],
    ...overrides,
  };
}

describe("diffPullRequestMonitorSnapshot", () => {
  it("emits new review comments and check failures once", () => {
    const first = snapshot({
      reviewThreads: [
        {
          id: "t1",
          author: { login: "rev", kind: "user" },
          path: "a.ts",
          line: 3,
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:00.000Z",
          resolved: false,
          latestCommentByViewer: false,
          bodyExcerpt: "please fix",
        },
      ],
      checkRuns: [
        {
          id: "c1",
          name: "ci",
          status: "success",
          headSha: "abc123",
          url: null,
          description: null,
        },
      ],
    });
    const cursor = cursorFromSnapshot(first);
    const second = snapshot({
      sourceRevision: "rev-2",
      reviewThreads: [
        {
          id: "t1",
          author: { login: "rev", kind: "user" },
          path: "a.ts",
          line: 3,
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:10:00.000Z",
          resolved: false,
          latestCommentByViewer: false,
          bodyExcerpt: "please fix now",
        },
      ],
      checkRuns: [
        {
          id: "c2",
          name: "ci",
          status: "failure",
          headSha: "abc123",
          url: null,
          description: null,
        },
      ],
      reviews: [
        {
          id: "r1",
          author: { login: "rev", kind: "user" },
          state: "changes-requested",
          submittedAt: "2026-08-11T00:10:00.000Z",
          commitSha: "abc123",
          bodyExcerpt: "nits",
        },
      ],
    });

    const { actionableEvents, nextCursor } = diffPullRequestMonitorSnapshot(cursor, second);
    expect(actionableEvents.map((event) => event.kind).sort()).toEqual([
      "changes-requested-review",
      "check-failed",
      "new-review-comment",
    ]);
    expect(nextCursor.headSha).toBe("abc123");
    expect(diffPullRequestMonitorSnapshot(nextCursor, second).actionableEvents).toEqual([]);
  });

  it("detects behind-base transitions from an empty cursor", () => {
    const { actionableEvents } = diffPullRequestMonitorSnapshot(
      emptyCursor(),
      snapshot({ behindBaseBy: 2 }),
    );
    expect(actionableEvents.some((event) => event.kind === "behind-base")).toBe(true);
  });
});
