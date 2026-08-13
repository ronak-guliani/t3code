import { describe, expect, it } from "@effect/vitest";
import type { PullRequestMonitorReadiness, PullRequestMonitorSnapshot } from "@t3tools/contracts";

import {
  buildFallbackMaintenancePrompt,
  buildWakePrompt,
  formatBlockersSummary,
} from "./wakePrompt.ts";

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
  fetchedAt: "2026-08-11T00:00:00.000Z",
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
    expect(prompt).toContain("Check");
    expect(prompt).toContain("untrusted data");
    expect(prompt.length).toBeLessThan(4_000);
  });

  it("falls back to revision summaries when events are empty", () => {
    const prompt = buildWakePrompt({
      prNumber: 12,
      repository: "acme/app",
      deliveryId: "del_2",
      events: [],
      revisionSummaries: ["check-failed: ci", "new-review-comment: thr_1"],
      snapshot,
      readiness,
    });
    expect(prompt).toContain("check-failed: ci");
    expect(prompt).toContain("new-review-comment");
  });

  it("builds a bounded fallback maintenance prompt", () => {
    const prompt = buildFallbackMaintenancePrompt({
      prNumber: 12,
      repository: "acme/app",
      url: "https://github.com/acme/app/pull/12",
      headBranch: "feat/x",
      headSha: "abc123",
      reason: "owner-missing",
      previousOwnerThreadId: null,
      note: "CI still red",
      readinessSummary: formatBlockersSummary(readiness),
    });
    expect(prompt).toContain("fallback PR maintenance");
    expect(prompt).toContain("sole modifying owner");
    expect(prompt).toContain("CI still red");
    expect(prompt.length).toBeLessThan(4_000);
  });

  it("caps many long blockers so the prompt stays bounded", () => {
    const crowded: PullRequestMonitorReadiness = {
      ready: false,
      label: "blocked",
      blockers: Array.from({ length: 40 }, (_, index) => ({
        kind: "check-failed" as const,
        detail: `check-${index} ${"x".repeat(500)}`,
      })),
    };
    const summary = formatBlockersSummary(crowded);
    expect(summary.length).toBeLessThanOrEqual(1_200);
    expect(summary).toContain("more");
    const prompt = buildFallbackMaintenancePrompt({
      prNumber: 12,
      repository: "acme/app",
      url: "https://github.com/acme/app/pull/12",
      headBranch: "feat/x",
      headSha: "abc123",
      reason: "owner-unavailable",
      previousOwnerThreadId: "thr_old",
      note: "x".repeat(2_000),
      readinessSummary: summary,
    });
    expect(prompt.length).toBeLessThan(4_000);
  });
});
