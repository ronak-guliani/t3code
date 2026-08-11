import { describe, expect, it } from "@effect/vitest";
import type { PullRequestMonitorReadiness, PullRequestMonitorSnapshot } from "@t3tools/contracts";

import { buildWakePrompt, formatBlockersSummary } from "./wakePrompt.ts";

const snapshot = {
  provider: "github",
  host: "github.com",
  repository: "acme/app",
  number: 12,
  state: "open",
  isDraft: false,
  headSha: "abc123def456",
  baseBranch: "main",
  headBranch: "feat/x",
  mergeability: "mergeable",
  behindBaseBy: 0,
  titleExcerpt: "Add feature",
  url: "https://github.com/acme/app/pull/12",
  fetchedAt: new Date().toISOString(),
  sourceRevision: "rev1",
  completeness: {
    reviewsComplete: true,
    reviewThreadsComplete: true,
    issueCommentsComplete: true,
    checksComplete: true,
    requiredChecksKnown: false,
  },
  reviews: [],
  reviewThreads: [],
  issueComments: [],
  checkRuns: [],
} as unknown as PullRequestMonitorSnapshot;

const readiness: PullRequestMonitorReadiness = {
  ready: false,
  label: "blocked",
  blockers: [{ kind: "check-failed", detail: "ci" }],
};

describe("wakePrompt", () => {
  it("formats blockers and bounds the wake prompt", () => {
    expect(formatBlockersSummary(readiness)).toContain("check-failed");
    const prompt = buildWakePrompt({
      prNumber: 12,
      repository: "acme/app",
      deliveryId: "del_1",
      events: [{ kind: "check-failed", sourceId: "check-1", detail: "ci" }],
      snapshot,
      readiness,
    });
    expect(prompt).toContain("acme/app#12");
    expect(prompt).toContain("t3_pr_monitor_report");
    expect(prompt.length).toBeLessThan(4_000);
  });
});
