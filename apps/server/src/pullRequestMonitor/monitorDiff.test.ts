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
      baseComparisonKnown: true,
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

  it("emits merge conflicts but ignores base distance", () => {
    const behind = snapshot({ behindBaseBy: 2 });
    const behindResult = diffPullRequestMonitorSnapshot(emptyCursor(), behind);
    expect(behindResult.actionableEvents).toEqual([]);

    const conflicting = snapshot({ behindBaseBy: 2, mergeability: "conflicting" });
    const conflictResult = diffPullRequestMonitorSnapshot(behindResult.nextCursor, conflicting);
    expect(conflictResult.actionableEvents).toEqual([{ kind: "merge-conflict" }]);
    expect(
      diffPullRequestMonitorSnapshot(conflictResult.nextCursor, conflicting).actionableEvents,
    ).toEqual([]);
  });

  it("never wakes the owner for our own issue comments", () => {
    const withSelfComment = snapshot({
      issueComments: [
        {
          id: "ic-self",
          author: { login: "me", kind: "user" },
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:00.000Z",
          authoredByViewer: true,
          bodyExcerpt: "pushed a fix",
        },
        {
          id: "ic-other",
          author: { login: "reviewer", kind: "user" },
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:00.000Z",
          authoredByViewer: false,
          bodyExcerpt: "still broken",
        },
      ],
    });
    const { actionableEvents, nextCursor } = diffPullRequestMonitorSnapshot(
      emptyCursor(),
      withSelfComment,
    );
    expect(actionableEvents.map((event) => event.sourceId)).toEqual(["ic-other"]);
    // Self comments still advance the cursor so an edit of ours cannot resurface later.
    expect(Object.keys(nextCursor.issueCommentVersions).sort()).toEqual(["ic-other", "ic-self"]);
  });

  it("records a cancelled check as its own outcome rather than success", () => {
    const cancelled = snapshot({
      checkRuns: [
        {
          id: "c1",
          name: "ci",
          status: "cancelled",
          headSha: "abc123",
          url: null,
          description: null,
        },
      ],
    });
    const cursor = cursorFromSnapshot(cancelled);
    expect(Object.values(cursor.checkRuns).map((entry) => entry.outcome)).toEqual(["cancelled"]);
  });
});
