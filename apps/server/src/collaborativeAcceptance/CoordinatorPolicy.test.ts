import { assert, describe, it } from "@effect/vitest";
import {
  CollaborativeAcceptanceCandidateId,
  CollaborativeAcceptanceCaseId,
  ProjectId,
  type CollaborativeAcceptanceCandidateSubmission,
  type CollaborativeAcceptancePolicy,
} from "@t3tools/contracts";

import {
  canonicalizeCandidateSubmission,
  shouldAutomaticallyReviewCandidate,
} from "./Coordinator.ts";

const policy = (automation: CollaborativeAcceptancePolicy["automation"]) =>
  ({
    automation,
    reviewTrigger: "each-eligible-candidate",
    reviewWorkflow: { identity: "saved-review", version: "2" },
    commentPolicy: "blocking-only",
    budgets: {
      exchanges: 3,
      modelSpendCents: 0,
      retries: 1,
      disputeRounds: 1,
      executionDurationSeconds: 0,
      waitingDeadlineSeconds: 0,
    },
  }) satisfies CollaborativeAcceptancePolicy;

const submission: CollaborativeAcceptanceCandidateSubmission = {
  assignmentId: "assignment-1",
  candidate: {
    candidateId: CollaborativeAcceptanceCandidateId.make("candidate-1"),
    reviewEpoch: 1,
    headSha: "head-1",
    contractRevision: "contract-1",
    reviewWorkflow: { identity: "caller-review", version: "1" },
    createdAt: "2026-09-21T00:00:00.000Z",
  },
  pullRequest: {
    projectId: ProjectId.make("project-1"),
    repository: "owner/repo",
    number: 1,
  },
  criteria: [],
  policy: policy("until-ready"),
  initialEvidence: [],
  reviewCandidate: {
    caseId: CollaborativeAcceptanceCaseId.make("case-1"),
    candidateId: CollaborativeAcceptanceCandidateId.make("candidate-1"),
    reviewEpoch: 1,
    headSha: "head-1",
    contractRevision: "contract-1",
    reviewWorkflow: { identity: "caller-review", version: "1" },
    coverage: { required: [], covered: [], applicability: "known" },
    previousFindingVerification: {
      required: false,
      complete: true,
      verifiedRevisionIds: [],
      unresolvedRevisionIds: [],
    },
  },
};

describe("collaborative acceptance policy admission", () => {
  it("captures the saved policy and workflow for a new case", () => {
    const savedPolicy = policy("bounded");
    const result = canonicalizeCandidateSubmission({
      submission,
      existingPolicy: null,
      configuredPolicy: savedPolicy,
    });
    assert.isNotNull(result);
    assert.deepStrictEqual(result?.policy, savedPolicy);
    assert.deepStrictEqual(result?.candidate.reviewWorkflow, savedPolicy.reviewWorkflow);
    assert.deepStrictEqual(result?.reviewCandidate.reviewWorkflow, savedPolicy.reviewWorkflow);
  });

  it("keeps the durable policy for existing cases", () => {
    const durablePolicy = policy("off");
    const result = canonicalizeCandidateSubmission({
      submission,
      existingPolicy: durablePolicy,
      configuredPolicy: policy("until-ready"),
    });
    assert.deepStrictEqual(result?.policy, durablePolicy);
  });

  it("rejects new case initiation when no policy is configured", () => {
    assert.isNull(
      canonicalizeCandidateSubmission({
        submission,
        existingPolicy: null,
        configuredPolicy: null,
      }),
    );
  });

  it("admits repeated bounded candidates only for each-candidate triggers", () => {
    assert.isTrue(
      shouldAutomaticallyReviewCandidate({
        policy: policy("bounded"),
        previouslyReviewedEligibleCandidate: true,
      }),
    );
    assert.isFalse(
      shouldAutomaticallyReviewCandidate({
        policy: { ...policy("bounded"), reviewTrigger: "first-candidate" },
        previouslyReviewedEligibleCandidate: true,
      }),
    );
    assert.isFalse(
      shouldAutomaticallyReviewCandidate({
        policy: policy("off"),
        previouslyReviewedEligibleCandidate: false,
      }),
    );
  });

  it("keeps until-ready subject to the same trigger admission", () => {
    assert.isTrue(
      shouldAutomaticallyReviewCandidate({
        policy: policy("until-ready"),
        previouslyReviewedEligibleCandidate: true,
      }),
    );
    assert.isFalse(
      shouldAutomaticallyReviewCandidate({
        policy: { ...policy("until-ready"), reviewTrigger: "manual" },
        previouslyReviewedEligibleCandidate: false,
      }),
    );
  });
});
