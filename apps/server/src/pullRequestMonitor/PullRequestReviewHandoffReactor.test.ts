import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  handoffFromReviewResult,
  handoffToSubmitInput,
  reviewFindingKey,
} from "./PullRequestReviewHandoffReactor.ts";

const snapshot = {
  scope: {
    kind: "pull-request" as const,
    number: 12,
    title: "Add monitor",
    url: "https://github.com/acme/app/pull/12",
    baseBranch: "main",
    headBranch: "feat",
  },
  diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n x\n+y\n",
  diffHash: "diffhash-1",
};

const finding = (
  overrides: Partial<{
    id: string;
    priority: string;
    title: string;
    body: string;
    path: string;
    startLine: number;
  }> = {},
) => ({
  id: overrides.id ?? "finding-1",
  priority: (overrides.priority ?? "high") as "critical" | "high" | "medium" | "low",
  title: overrides.title ?? "Null deref",
  body: overrides.body ?? "This can be null.",
  confidence: 0.9,
  location: {
    path: overrides.path ?? "src/a.ts",
    side: "new" as const,
    startLine: overrides.startLine ?? 2,
    endLine: overrides.startLine ?? 2,
  },
});

const parsed = (findings = [finding()], snapshotOverride = {}) => ({
  status: "parsed" as const,
  snapshot: { ...snapshot, ...snapshotOverride },
  findings,
  verdict: "request-changes" as const,
  summary: "Two issues found.",
});

describe("handoffFromReviewResult", () => {
  const projectId = ProjectId.make("proj_1");

  it("converts a parsed PR review into a handoff", () => {
    const handoff = handoffFromReviewResult({
      reviewThreadId: ThreadId.make("thr_review"),
      projectId,
      result: parsed(),
    });
    expect(handoff).toMatchObject({
      reviewThreadId: "thr_review",
      projectId: "proj_1",
      repository: "acme/app",
      number: 12,
      summary: "Two issues found.",
    });
    expect(handoff?.findings).toHaveLength(1);
  });

  it("ignores invalid output, zero-finding reviews, and non-PR scopes", () => {
    const input = { reviewThreadId: ThreadId.make("thr"), projectId };
    expect(
      handoffFromReviewResult({
        ...input,
        result: { status: "invalid-output", snapshot, issues: ["bad"] },
      }),
    ).toBeNull();
    expect(handoffFromReviewResult({ ...input, result: parsed([]) })).toBeNull();
    expect(
      handoffFromReviewResult({
        ...input,
        result: parsed([finding()], {
          scope: { kind: "uncommitted", branch: "main", untrackedFiles: [] },
        }),
      }),
    ).toBeNull();
  });

  it("ignores a PR url whose repository cannot be derived", () => {
    expect(
      handoffFromReviewResult({
        reviewThreadId: ThreadId.make("thr"),
        projectId,
        result: parsed([finding()], {
          scope: { ...snapshot.scope, url: "not-a-url" },
        }),
      }),
    ).toBeNull();
  });
});

describe("handoffToSubmitInput", () => {
  const review = handoffFromReviewResult({
    reviewThreadId: ThreadId.make("thr_review"),
    projectId: ProjectId.make("proj_1"),
    result: parsed([
      finding({ priority: "critical" }),
      finding({ id: "finding-2", priority: "medium", title: "Naming", startLine: 3 }),
      finding({ id: "finding-3", priority: "low", title: "Typo", startLine: 4 }),
    ]),
  })!;

  it("preserves reference, locations, and maps priorities to severities", () => {
    const input = handoffToSubmitInput(review);
    const findings = input.findings ?? [];
    expect(input.reference).toEqual({
      projectId: "proj_1",
      repository: "acme/app",
      number: 12,
    });
    expect(input.reviewThreadId).toBe("thr_review");
    expect(findings.map((entry) => entry.severity)).toEqual(["blocker", "minor", "nit"]);
    expect(findings[0]).toMatchObject({ path: "src/a.ts", line: 2 });
  });

  it("derives content-stable keys that survive positional reordering", () => {
    const first = (handoffToSubmitInput(review).findings ?? []).map((entry) => entry.key);
    // Same content in a different order must keep each finding's key stable.
    const reordered = (
      handoffToSubmitInput({ ...review, findings: [...review.findings].reverse() }).findings ?? []
    ).map((entry) => entry.key);
    expect([...reordered].sort()).toEqual([...first].sort());
  });

  it("truncates fields beyond contract limits instead of rejecting the submit", () => {
    const long = "x".repeat(3_000);
    const input = handoffToSubmitInput({
      ...review,
      summary: long,
      findings: [
        {
          id: "f",
          priority: "high",
          title: long,
          body: long,
          location: { path: long, startLine: 1 },
        },
      ],
    });
    const [finding] = input.findings ?? [];
    expect(input.summary!.length).toBeLessThanOrEqual(2_000);
    expect(finding!.title.length).toBeLessThanOrEqual(200);
    expect(finding!.detail.length).toBeLessThanOrEqual(2_000);
    expect(finding!.path!.length).toBeLessThanOrEqual(500);
  });

  it("keys differ when content differs at the same location", () => {
    const keyOf = (title: string) =>
      reviewFindingKey({ diffHash: "h", path: "a.ts", startLine: 2, title });
    expect(keyOf("one")).not.toBe(keyOf("two"));
    expect(reviewFindingKey({ diffHash: "h", path: "a.ts", startLine: 2, title: "t" })).not.toBe(
      reviewFindingKey({ diffHash: "h", path: "b.ts", startLine: 2, title: "t" }),
    );
  });
});
