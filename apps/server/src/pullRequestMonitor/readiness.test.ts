import { describe, expect, it } from "@effect/vitest";
import type { PullRequestMonitorSnapshot } from "@t3tools/contracts";

import { computeReadiness } from "./readiness.ts";

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
    ...overrides,
  };
}

describe("computeReadiness", () => {
  it("labels ready-to-merge only when required checks are known", () => {
    const ready = computeReadiness(snapshot());
    expect(ready).toEqual({
      ready: true,
      label: "ready-to-merge",
      blockers: [],
    });

    const unknownRequired = computeReadiness(
      snapshot({
        completeness: {
          reviewsComplete: true,
          reviewThreadsComplete: true,
          issueCommentsComplete: true,
          checksComplete: true,
          requiredChecksKnown: false,
        },
      }),
    );
    expect(unknownRequired.label).toBe("no-known-blockers");
    expect(unknownRequired.ready).toBe(true);
  });

  it("blocks on changes-requested and unresolved threads", () => {
    const result = computeReadiness(
      snapshot({
        reviews: [
          {
            id: "r1",
            author: { login: "rev", kind: "user" },
            state: "changes-requested",
            submittedAt: "2026-08-11T00:00:00.000Z",
            commitSha: "abc123",
            bodyExcerpt: "fix",
          },
        ],
        reviewThreads: [
          {
            id: "t1",
            author: { login: "rev", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T01:00:00.000Z",
            resolved: false,
            latestCommentByViewer: false,
            bodyExcerpt: "nit",
          },
        ],
      }),
      {},
      "2026-08-11T00:30:00.000Z",
    );
    expect(result.ready).toBe(false);
    expect(result.label).toBe("blocked");
    expect(result.blockers.map((blocker) => blocker.kind).sort()).toEqual([
      "changes-requested",
      "unresolved-thread",
    ]);
  });
});
