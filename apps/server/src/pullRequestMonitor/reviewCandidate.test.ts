import { describe, expect, it } from "vitest";

import {
  dedupeReviewCandidates,
  reviewCandidateEligibility,
  reviewCandidateKey,
} from "./reviewCandidate.ts";

const candidate = (
  overrides: Partial<Parameters<typeof reviewCandidateKey>[0]> = {},
): Parameters<typeof reviewCandidateKey>[0] => ({
  candidateId: "pr-12",
  headSha: "head-1",
  contractRevision: "contract-1",
  workflowId: "acceptance",
  workflowVersion: "1",
  coverage: {
    required: ["diff", "threads"],
    covered: [],
    applicability: "known",
  },
  ...overrides,
});

describe("review candidate eligibility", () => {
  it("deduplicates equivalent candidate requests without turn completion state", () => {
    const first = candidate();
    expect(dedupeReviewCandidates([first, { ...first }])).toHaveLength(1);
    expect(reviewCandidateEligibility({ candidate: first, previous: first })).toEqual({
      eligible: false,
      mode: null,
      reason: "duplicate",
    });
  });

  it("creates a delta review for a relevant head movement", () => {
    expect(
      reviewCandidateEligibility({
        previous: candidate(),
        candidate: candidate({ headSha: "head-2" }),
      }),
    ).toEqual({ eligible: true, mode: "delta", reason: "head-changed" });
  });

  it("requires a full review when applicability is unknown or coverage expands", () => {
    expect(
      reviewCandidateEligibility({
        previous: candidate(),
        candidate: candidate({
          headSha: "head-2",
          coverage: {
            required: ["diff", "threads", "checks"],
            covered: [],
            applicability: "known",
          },
        }),
      }),
    ).toEqual({ eligible: true, mode: "full", reason: "coverage-expanded" });

    expect(
      reviewCandidateEligibility({
        previous: candidate(),
        candidate: candidate({
          headSha: "head-2",
          coverage: {
            required: ["diff", "threads"],
            covered: [],
            applicability: "unknown",
          },
        }),
      }),
    ).toEqual({ eligible: true, mode: "full", reason: "coverage-unknown" });
  });

  it("changes identity when contract or workflow revision changes", () => {
    const original = candidate();
    expect(reviewCandidateKey(original)).not.toBe(
      reviewCandidateKey({ ...original, contractRevision: "contract-2" }),
    );
    expect(
      reviewCandidateEligibility({
        previous: original,
        candidate: { ...original, workflowVersion: "2" },
      }),
    ).toEqual({ eligible: true, mode: "full", reason: "workflow-changed" });
  });
});
