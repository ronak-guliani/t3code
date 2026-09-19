import { assert, describe, it } from "@effect/vitest";
import {
  CollaborativeAcceptanceAssessmentId,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceCandidateId,
  CollaborativeAcceptanceEvidenceId,
  CollaborativeAcceptanceExchangeId,
  CollaborativeAcceptanceExecutionId,
  ProjectId,
  ThreadId,
  type CollaborativeAcceptanceAssessment,
  type CollaborativeAcceptanceCase,
  type CollaborativeAcceptanceCandidate,
  type CollaborativeAcceptanceEvidence,
  type CollaborativeAcceptanceExchange,
  type CollaborativeAcceptanceProviderEvidence,
} from "@t3tools/contracts";

import {
  cancelExchange,
  completeExchange,
  advanceAcceptanceCandidate,
  evaluateAcceptance,
  recordExchangeOutcome,
  reserveExchange,
  startExchange,
  type AcceptanceEvaluationInput,
  type AcceptanceExchangeLedger,
} from "./domain.ts";

const now = "2026-09-19T00:00:00.000Z";

const candidate: CollaborativeAcceptanceCandidate = {
  candidateId: CollaborativeAcceptanceCandidateId.make("candidate-a"),
  reviewEpoch: 1,
  headSha: "sha-a",
  contractRevision: "contract-1",
  reviewWorkflow: { identity: "review-v1", version: "1" },
  createdAt: now,
};

const acceptanceCase: CollaborativeAcceptanceCase = {
  caseId: CollaborativeAcceptanceCaseId.make("case-1"),
  assignmentId: "assignment-1",
  parentThreadId: ThreadId.make("parent-1"),
  pullRequest: {
    projectId: ProjectId.make("project-1"),
    repository: "owner/repo",
    number: 1,
  },
  contractRevision: "contract-1",
  currentCandidate: candidate,
  criteria: [
    {
      criterionId: "tests",
      description: "Required tests pass",
      required: true,
      evidenceKinds: ["criterion"],
    },
  ],
  policy: {
    automation: "bounded",
    reviewTrigger: "each-eligible-candidate",
    reviewWorkflow: { identity: "review-v1", version: "1" },
    commentPolicy: "all-actionable-addressed",
    budgets: {
      exchanges: 2,
      modelSpendCents: 100,
      retries: 1,
      disputeRounds: 1,
      executionDurationSeconds: 60,
      waitingDeadlineSeconds: 60,
    },
  },
  createdAt: now,
  updatedAt: now,
};

const childAssessment: CollaborativeAcceptanceAssessment = {
  assessmentId: CollaborativeAcceptanceAssessmentId.make("child-a"),
  caseId: acceptanceCase.caseId,
  role: "child-implementer",
  kind: "attestation",
  outcome: "pass",
  candidateId: candidate.candidateId,
  reviewEpoch: candidate.reviewEpoch,
  headSha: candidate.headSha,
  contractRevision: candidate.contractRevision,
  reviewWorkflow: candidate.reviewWorkflow,
  criteriaEvidenceIds: [CollaborativeAcceptanceEvidenceId.make("criterion-a")],
  createdAt: now,
};

const parentAssessment: CollaborativeAcceptanceAssessment = {
  ...childAssessment,
  assessmentId: CollaborativeAcceptanceAssessmentId.make("parent-a"),
  role: "parent-reviewer",
};

const criterionEvidence: CollaborativeAcceptanceEvidence = {
  evidenceId: CollaborativeAcceptanceEvidenceId.make("criterion-a"),
  caseId: acceptanceCase.caseId,
  candidateId: candidate.candidateId,
  headSha: candidate.headSha,
  kind: "criterion",
  criterionId: "tests",
  sourceId: "test-run",
  summary: "Tests passed",
  complete: true,
  current: true,
  observedAt: now,
};

const providerEvidence: CollaborativeAcceptanceProviderEvidence = {
  candidateId: candidate.candidateId,
  headSha: candidate.headSha,
  sourceRevision: "provider-1",
  complete: true,
  pullRequestState: "open",
  isDraft: false,
  mergeability: "mergeable",
  reviewEvidenceComplete: true,
  reviewThreadEvidenceComplete: true,
  commentEvidenceComplete: true,
  checkEvidenceComplete: true,
  requiredChecksKnown: true,
  requiredChecks: [{ name: "ci", status: "success", headSha: candidate.headSha }],
  requiredCheckCoverage: {
    expected: ["ci"],
    observed: [{ name: "ci", status: "success", headSha: candidate.headSha }],
    completeness: "complete",
  },
  unresolvedActionableFindings: 0,
  unresolvedReviewThreads: 0,
  observedAt: now,
};

const input = (overrides: Partial<AcceptanceEvaluationInput> = {}): AcceptanceEvaluationInput => ({
  case: acceptanceCase,
  candidate,
  executionPhase: "verifying",
  providerEvidence,
  evidence: [criterionEvidence],
  assessments: [childAssessment, parentAssessment],
  collaborationObligations: [],
  updatedAt: now,
  ...overrides,
});

describe("evaluateAcceptance", () => {
  it("requires exact current provenance for ready-now", () => {
    const result = evaluateAcceptance(input());
    assert.strictEqual(result.projection.acceptanceLifecycle, "accepted");
    assert.strictEqual(result.projection.readiness, "ready-now");

    const movedCandidate = {
      ...candidate,
      candidateId: CollaborativeAcceptanceCandidateId.make("candidate-b"),
      reviewEpoch: 2,
      headSha: "sha-b",
    };
    const moved = evaluateAcceptance(input({ candidate: movedCandidate }));
    assert.notStrictEqual(moved.projection.readiness, "ready-now");
    assert.strictEqual(moved.projection.acceptanceLifecycle, "pending");
    assert.strictEqual(moved.projection.executionPhase, "verifying");
    assert.deepStrictEqual(moved.projection.staleAssessmentIds, [
      childAssessment.assessmentId,
      parentAssessment.assessmentId,
    ]);
  });

  it("advances the review epoch instead of mutating an existing candidate", () => {
    const nextCandidate = {
      ...candidate,
      candidateId: CollaborativeAcceptanceCandidateId.make("candidate-b"),
      reviewEpoch: 2,
      headSha: "sha-b",
    };
    const result = advanceAcceptanceCandidate(acceptanceCase, nextCandidate);
    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.strictEqual(
      result.acceptanceCase.currentCandidate.candidateId,
      nextCandidate.candidateId,
    );
    assert.strictEqual(result.acceptanceCase.currentCandidate.headSha, "sha-b");
  });

  it("treats incomplete provider evidence as monitoring and never ready-now", () => {
    const result = evaluateAcceptance(
      input({
        providerEvidence: { ...providerEvidence, complete: false, checkEvidenceComplete: false },
      }),
    );
    assert.strictEqual(result.projection.acceptanceLifecycle, "monitoring");
    assert.strictEqual(result.projection.readiness, "no-known-blockers");
  });

  it("does not count acknowledgement as attestation", () => {
    const result = evaluateAcceptance(
      input({
        assessments: [
          { ...childAssessment, kind: "acknowledgement", outcome: "acknowledged" },
          parentAssessment,
        ],
      }),
    );
    assert.strictEqual(result.projection.acceptanceLifecycle, "pending");
    assert.strictEqual(result.projection.collaborationStatus, "child-assessment-pending");
  });

  it("requests changes for current actionable provider findings", () => {
    const result = evaluateAcceptance(
      input({
        providerEvidence: { ...providerEvidence, unresolvedActionableFindings: 1 },
      }),
    );
    assert.strictEqual(result.projection.acceptanceLifecycle, "changes-requested");
    assert.strictEqual(result.projection.readiness, "blocked");
  });

  const evidenceKinds = [
    "criterion",
    "provider-review",
    "provider-review-thread",
    "provider-comment",
    "provider-check",
    "provider-mergeability",
    "assessment",
    "test",
    "artifact",
    "manual",
  ] as const;

  for (const kind of evidenceKinds) {
    it(`accepts current ${kind} evidence when the criterion allows it`, () => {
      const evidence = {
        ...criterionEvidence,
        evidenceId: CollaborativeAcceptanceEvidenceId.make(`evidence-${kind}`),
        kind,
      };
      const result = evaluateAcceptance(
        input({
          case: {
            ...acceptanceCase,
            criteria: [{ ...acceptanceCase.criteria[0]!, evidenceKinds: [kind] }],
          },
          evidence: [evidence],
          assessments: [
            {
              ...childAssessment,
              criteriaEvidenceIds: [evidence.evidenceId],
            },
            parentAssessment,
          ],
        }),
      );
      assert.strictEqual(result.projection.acceptanceLifecycle, "accepted");
      assert.strictEqual(result.projection.readiness, "ready-now");
    });
  }

  it("requires evidence for every mixed required criterion kind", () => {
    const artifactEvidence = {
      ...criterionEvidence,
      evidenceId: CollaborativeAcceptanceEvidenceId.make("artifact-evidence"),
      criterionId: "artifact",
      kind: "artifact" as const,
    };
    const manualEvidence = {
      ...criterionEvidence,
      evidenceId: CollaborativeAcceptanceEvidenceId.make("manual-evidence"),
      criterionId: "manual",
      kind: "manual" as const,
    };
    const result = evaluateAcceptance(
      input({
        case: {
          ...acceptanceCase,
          criteria: [
            {
              ...acceptanceCase.criteria[0]!,
              criterionId: "artifact",
              evidenceKinds: ["artifact"],
            },
            {
              ...acceptanceCase.criteria[0]!,
              criterionId: "manual",
              evidenceKinds: ["manual"],
            },
          ],
        },
        evidence: [artifactEvidence, manualEvidence],
        assessments: [
          {
            ...childAssessment,
            criteriaEvidenceIds: [artifactEvidence.evidenceId, manualEvidence.evidenceId],
          },
          parentAssessment,
        ],
      }),
    );
    assert.strictEqual(result.projection.acceptanceLifecycle, "accepted");
    assert.strictEqual(result.projection.readiness, "ready-now");
  });

  it("does not satisfy a criterion with missing or stale candidate evidence", () => {
    const missing = evaluateAcceptance(
      input({
        evidence: [],
      }),
    );
    assert.strictEqual(missing.projection.acceptanceLifecycle, "verifying");
    assert.strictEqual(missing.projection.readiness, "blocked");

    const stale = evaluateAcceptance(
      input({
        evidence: [{ ...criterionEvidence, headSha: "old-head" }],
      }),
    );
    assert.strictEqual(stale.projection.acceptanceLifecycle, "verifying");
    assert.strictEqual(stale.projection.readiness, "blocked");
  });
});

describe("exchange accounting", () => {
  const exchange: CollaborativeAcceptanceExchange = {
    exchangeId: CollaborativeAcceptanceExchangeId.make("exchange-1"),
    caseId: acceptanceCase.caseId,
    executionId: CollaborativeAcceptanceExecutionId.make("execution-1"),
    status: "reserved",
    retryCount: 0,
    reservedAt: now,
    startedAt: null,
    outcomeRecordedAt: null,
    completedAt: null,
    cancelledAt: null,
    modelSpendCents: 0,
  };
  const ledger: AcceptanceExchangeLedger = {
    budget: acceptanceCase.policy.budgets,
    exchanges: [],
  };

  it("debits exactly once across ambiguous retry responses", () => {
    const reserved = reserveExchange(ledger, exchange);
    assert.isTrue(reserved.ok);
    if (!reserved.ok) return;
    const started = startExchange(reserved.ledger, exchange.exchangeId, now);
    assert.isTrue(started.ok);
    if (!started.ok) return;
    const recorded = recordExchangeOutcome(started.ledger, exchange.exchangeId, now);
    assert.isTrue(recorded.ok);
    if (!recorded.ok) return;
    const retriedReservation = reserveExchange(recorded.ledger, exchange);
    assert.isTrue(retriedReservation.ok);
    if (!retriedReservation.ok) return;
    const retry = startExchange(retriedReservation.ledger, exchange.exchangeId, now);
    assert.isTrue(retry.ok);
    if (!retry.ok) return;
    assert.strictEqual(retry.ledger.exchanges.length, 1);
    assert.strictEqual(retry.exchange.status, "committed");
    assert.strictEqual(retry.exchange.retryCount, 1);
  });

  it("releases a pre-start reservation but does not refund a started exchange", () => {
    const reserved = reserveExchange(ledger, exchange);
    assert.isTrue(reserved.ok);
    if (!reserved.ok) return;
    const cancelled = cancelExchange(reserved.ledger, exchange.exchangeId, now);
    assert.isTrue(cancelled.ok);
    if (!cancelled.ok) return;
    assert.strictEqual(cancelled.exchange.status, "cancelled");
    assert.strictEqual(cancelled.exchange.startedAt, null);

    const started = startExchange(reserved.ledger, exchange.exchangeId, now);
    assert.isTrue(started.ok);
    if (!started.ok) return;
    const cancelledAfterStart = cancelExchange(started.ledger, exchange.exchangeId, now);
    assert.isTrue(cancelledAfterStart.ok);
    if (!cancelledAfterStart.ok) return;
    assert.strictEqual(cancelledAfterStart.exchange.startedAt, now);
  });

  it("enforces the lifecycle ordering", () => {
    const reserved = reserveExchange(ledger, exchange);
    assert.isTrue(reserved.ok);
    if (!reserved.ok) return;
    const started = startExchange(reserved.ledger, exchange.exchangeId, now);
    assert.isTrue(started.ok);
    if (!started.ok) return;
    const recorded = recordExchangeOutcome(started.ledger, exchange.exchangeId, now);
    assert.isTrue(recorded.ok);
    if (!recorded.ok) return;
    const completed = completeExchange(recorded.ledger, exchange.exchangeId, now);
    assert.isTrue(completed.ok);
    if (!completed.ok) return;
    assert.strictEqual(completed.exchange.status, "completed");
  });
});
