import { describe, expect, it } from "@effect/vitest";
import type { PullRequestMonitorSnapshot } from "@t3tools/contracts";

import { feedbackSourceIdOf, reconcileFeedbackItem } from "./feedbackReconciliation.ts";

function snapshot(overrides: Partial<PullRequestMonitorSnapshot> = {}): PullRequestMonitorSnapshot {
  return {
    provider: "github",
    host: "github.com",
    repository: "acme/app",
    number: 12,
    state: "open",
    isDraft: false,
    headSha: "head-1",
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

const reviewThread = (overrides: Partial<PullRequestMonitorSnapshot["reviewThreads"][number]>) => ({
  id: "thread-1",
  author: { login: "reviewer", kind: "user" as const },
  path: "a.ts",
  line: 1,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  resolved: false,
  latestCommentByViewer: false,
  bodyExcerpt: "please fix",
  ...overrides,
});

describe("reconcileFeedbackItem", () => {
  it("keeps an unresolved review thread actionable", () => {
    const result = reconcileFeedbackItem(
      { kind: "new-review-comment", stableKey: "new-review-comment:thread-1" },
      snapshot({ reviewThreads: [reviewThread({})] }),
    );
    expect(result.kind).toBe("actionable");
  });

  it("treats a provider-resolved thread as resolved upstream", () => {
    const result = reconcileFeedbackItem(
      { kind: "new-review-comment", stableKey: "new-review-comment:thread-1" },
      snapshot({ reviewThreads: [reviewThread({ resolved: true })] }),
    );
    expect(result.kind).toBe("resolved-upstream");
  });

  it("treats our own latest reply as resolved upstream", () => {
    const result = reconcileFeedbackItem(
      { kind: "new-review-comment", stableKey: "new-review-comment:thread-1" },
      snapshot({ reviewThreads: [reviewThread({ latestCommentByViewer: true })] }),
    );
    expect(result.kind).toBe("resolved-upstream");
  });

  it("supersedes a missing comment only when every page was observed", () => {
    const complete = reconcileFeedbackItem(
      { kind: "new-review-comment", stableKey: "new-review-comment:thread-gone" },
      snapshot(),
    );
    expect(complete.kind).toBe("superseded");

    const incomplete = reconcileFeedbackItem(
      { kind: "new-review-comment", stableKey: "new-review-comment:thread-gone" },
      snapshot({
        completeness: {
          reviewsComplete: true,
          reviewThreadsComplete: true,
          issueCommentsComplete: false,
          checksComplete: true,
          requiredChecksKnown: true,
          baseComparisonKnown: true,
        },
      }),
    );
    expect(incomplete.kind).toBe("actionable");
  });

  it("resolves a changes-requested review once the reviewer approves", () => {
    const result = reconcileFeedbackItem(
      { kind: "changes-requested-review", stableKey: "changes-requested-review:review-1" },
      snapshot({
        reviews: [
          {
            id: "review-1",
            author: { login: "reviewer", kind: "user" },
            state: "changes-requested",
            submittedAt: "2026-08-11T00:00:00.000Z",
            commitSha: "head-1",
            bodyExcerpt: "no",
          },
          {
            id: "review-2",
            author: { login: "reviewer", kind: "user" },
            state: "approved",
            submittedAt: "2026-08-11T01:00:00.000Z",
            commitSha: "head-1",
            bodyExcerpt: "ok",
          },
        ],
      }),
    );
    expect(result.kind).toBe("resolved-upstream");
  });

  it("resolves a failed check once the same check passes at head", () => {
    const result = reconcileFeedbackItem(
      { kind: "check-failed", stableKey: "check-failed:check-1" },
      snapshot({
        checkRuns: [
          {
            id: "check-1",
            name: "ci",
            status: "success",
            headSha: "head-1",
            url: null,
            description: null,
          },
        ],
      }),
    );
    expect(result.kind).toBe("resolved-upstream");
  });

  it("matches a re-run check by name when the run id changed", () => {
    const stillFailing = reconcileFeedbackItem(
      { kind: "check-failed", stableKey: "check-failed:check-1" },
      snapshot({
        checkRuns: [
          {
            id: "check-2",
            name: "ci",
            status: "failure",
            headSha: "head-1",
            url: null,
            description: null,
          },
        ],
      }),
      { checkName: "ci" },
    );
    expect(stillFailing.kind).toBe("actionable");
  });

  it("supersedes a failed check observed at an older head", () => {
    const result = reconcileFeedbackItem(
      { kind: "check-failed", stableKey: "check-failed:check-1" },
      snapshot({ headSha: "head-2" }),
      { checkName: "ci", observedHeadSha: "head-1" },
    );
    expect(result.kind).toBe("superseded");
  });

  it("keeps a claimed review finding open until the head advances", () => {
    const item = { kind: "review-finding" as const, stableKey: "review-finding:finding-1" };
    expect(reconcileFeedbackItem(item, snapshot(), { claimHeadSha: "head-1" }).kind).toBe(
      "actionable",
    );
    expect(reconcileFeedbackItem(item, snapshot(), { claimHeadSha: "head-0" }).kind).toBe(
      "resolved-upstream",
    );
    // An unclaimed finding is never closed by a push alone.
    expect(reconcileFeedbackItem(item, snapshot(), {}).kind).toBe("actionable");
  });

  it("retires legacy behind-base findings and tracks merge conflicts", () => {
    const legacy = reconcileFeedbackItem(
      { kind: "behind-base", stableKey: "behind-base:na" },
      snapshot({
        behindBaseBy: null,
        completeness: {
          reviewsComplete: true,
          reviewThreadsComplete: true,
          issueCommentsComplete: true,
          checksComplete: true,
          requiredChecksKnown: true,
          baseComparisonKnown: false,
        },
      }),
    );
    expect(legacy.kind).toBe("superseded");

    const conflict = reconcileFeedbackItem(
      { kind: "merge-conflict", stableKey: "merge-conflict:na" },
      snapshot({ mergeability: "conflicting" }),
    );
    expect(conflict.kind).toBe("actionable");

    const resolved = reconcileFeedbackItem(
      { kind: "merge-conflict", stableKey: "merge-conflict:na" },
      snapshot({ mergeability: "mergeable" }),
    );
    expect(resolved.kind).toBe("resolved-upstream");
  });

  it("reads the source id out of a stable key", () => {
    expect(feedbackSourceIdOf("check-failed:check-1")).toBe("check-1");
    expect(feedbackSourceIdOf("behind-base:na")).toBeNull();
    expect(feedbackSourceIdOf("behind-base")).toBeNull();
  });
});
