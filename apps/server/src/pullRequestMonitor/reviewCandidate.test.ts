import { describe, expect, it } from "vitest";
import {
  CollaborativeAcceptanceCandidateId,
  CollaborativeAcceptanceCaseId,
  PullRequestMonitorFeedbackRevisionId,
} from "@t3tools/contracts";

import {
  dedupeReviewCandidates,
  reviewCandidateEligibility,
  reviewCandidateKey,
} from "./reviewCandidate.ts";

const candidate = (
  overrides: Partial<Parameters<typeof reviewCandidateKey>[0]> = {},
): Parameters<typeof reviewCandidateKey>[0] => ({
  caseId: CollaborativeAcceptanceCaseId.make("case-1"),
  candidateId: CollaborativeAcceptanceCandidateId.make("pr-12"),
  reviewEpoch: 1,
  headSha: "head-1",
  contractRevision: "contract-1",
  reviewWorkflow: { identity: "acceptance", version: "1" },
  coverage: {
    required: ["diff", "threads"],
    covered: [],
    applicability: "known",
  },
  previousFindingVerification: {
    required: false,
    complete: true,
    verifiedRevisionIds: [],
    unresolvedRevisionIds: [],
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
      previousFindingsVerified: true,
    });
  });

  it("creates a delta review for a relevant head movement", () => {
    expect(
      reviewCandidateEligibility({
        previous: candidate(),
        candidate: candidate({ headSha: "head-2" }),
      }),
    ).toEqual({
      eligible: true,
      mode: "delta",
      reason: "head-changed",
      previousFindingsVerified: true,
    });
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
    ).toEqual({
      eligible: true,
      mode: "full",
      reason: "coverage-expanded",
      previousFindingsVerified: true,
    });

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
    ).toEqual({
      eligible: true,
      mode: "full",
      reason: "coverage-unknown",
      previousFindingsVerified: true,
    });
  });

  it("changes identity when contract or workflow revision changes", () => {
    const original = candidate();
    expect(reviewCandidateKey(original)).not.toBe(
      reviewCandidateKey({ ...original, contractRevision: "contract-2" }),
    );
    expect(
      reviewCandidateEligibility({
        previous: original,
        candidate: { ...original, reviewWorkflow: { identity: "acceptance", version: "2" } },
      }),
    ).toEqual({
      eligible: true,
      mode: "full",
      reason: "workflow-changed",
      previousFindingsVerified: true,
    });
  });

  it("exposes incomplete previous-finding verification without using it as a duplicate key", () => {
    const first = candidate({
      previousFindingVerification: {
        required: true,
        complete: false,
        verifiedRevisionIds: [],
        unresolvedRevisionIds: [PullRequestMonitorFeedbackRevisionId.make("revision-1")],
      },
    });
    expect(
      reviewCandidateEligibility({
        previous: first,
        candidate: { ...first, headSha: "head-2" },
      }),
    ).toMatchObject({
      eligible: true,
      mode: "delta",
      reason: "head-changed",
      previousFindingsVerified: false,
    });
    expect(
      dedupeReviewCandidates([
        first,
        { ...first, coverage: { ...first.coverage, covered: ["diff"] } },
      ]),
    ).toHaveLength(1);
  });
});
