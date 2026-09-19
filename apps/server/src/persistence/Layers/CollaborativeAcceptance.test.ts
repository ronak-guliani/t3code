import { assert, it } from "@effect/vitest";
import {
  CollaborativeAcceptanceAssessmentId,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceCandidateId,
  CollaborativeAcceptanceEvidenceId,
  CollaborativeAcceptanceExecutionId,
  CollaborativeAcceptanceExchangeId,
  ProjectId,
  ThreadId,
  type CollaborativeAcceptanceRecord,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { advanceAcceptanceCandidate } from "../../collaborativeAcceptance/domain.ts";
import { CollaborativeAcceptanceRepository } from "../Services/CollaborativeAcceptance.ts";
import { CollaborativeAcceptanceRepositoryLive } from "./CollaborativeAcceptance.ts";

const now = "2026-09-19T00:00:00.000Z";

const record = (): CollaborativeAcceptanceRecord => {
  const caseId = CollaborativeAcceptanceCaseId.make("case-repository");
  const candidateId = CollaborativeAcceptanceCandidateId.make("candidate-repository");
  const evidenceId = CollaborativeAcceptanceEvidenceId.make("evidence-repository");
  const assessmentId = CollaborativeAcceptanceAssessmentId.make("assessment-repository");
  const exchangeId = CollaborativeAcceptanceExchangeId.make("exchange-repository");
  const candidate = {
    candidateId,
    reviewEpoch: 1,
    headSha: "sha-repository",
    contractRevision: "contract-1",
    reviewWorkflow: { identity: "review-v1", version: "1" },
    createdAt: now,
  } as const;
  const acceptanceCase = {
    caseId,
    assignmentId: "assignment-repository",
    parentThreadId: ThreadId.make("parent-repository"),
    pullRequest: {
      projectId: ProjectId.make("project-repository"),
      repository: "owner/repository",
      number: 42,
    },
    contractRevision: "contract-1",
    currentCandidate: candidate,
    criteria: [
      {
        criterionId: "criterion",
        description: "Criterion",
        required: true,
        evidenceKinds: ["criterion"],
      },
    ],
    policy: {
      automation: "bounded",
      reviewTrigger: "first-candidate",
      reviewWorkflow: { identity: "review-v1", version: "1" },
      commentPolicy: "blocking-only",
      budgets: {
        exchanges: 1,
        modelSpendCents: 10,
        retries: 1,
        disputeRounds: 1,
        executionDurationSeconds: 60,
        waitingDeadlineSeconds: 60,
      },
    },
    createdAt: now,
    updatedAt: now,
  } as const;
  return {
    case: acceptanceCase,
    candidates: [candidate],
    evidence: [
      {
        evidenceId,
        caseId,
        candidateId,
        headSha: candidate.headSha,
        kind: "criterion",
        criterionId: "criterion",
        sourceId: "tests",
        summary: "passed",
        complete: true,
        current: true,
        observedAt: now,
      },
    ],
    assessments: [
      {
        assessmentId,
        caseId,
        role: "child-implementer",
        kind: "attestation",
        outcome: "pass",
        candidateId,
        reviewEpoch: candidate.reviewEpoch,
        headSha: candidate.headSha,
        contractRevision: candidate.contractRevision,
        reviewWorkflow: candidate.reviewWorkflow,
        criteriaEvidenceIds: [evidenceId],
        createdAt: now,
      },
    ],
    exchanges: [
      {
        exchangeId,
        caseId,
        executionId: CollaborativeAcceptanceExecutionId.make("execution-repository"),
        status: "reserved",
        retryCount: 0,
        reservedAt: now,
        startedAt: null,
        outcomeRecordedAt: null,
        completedAt: null,
        cancelledAt: null,
        modelSpendCents: 0,
      },
    ],
    projection: {
      caseId,
      candidateId,
      headSha: candidate.headSha,
      acceptanceStatus: "awaiting-review",
      collaborationStatus: "parent-assessment-pending",
      readiness: "blocked",
      reasons: ["parent-assessment-missing"],
      staleAssessmentIds: [],
      updatedAt: now,
    },
  };
};

const repositoryLayer = it.layer(
  CollaborativeAcceptanceRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

repositoryLayer("Collaborative acceptance repository", (it) => {
  it.effect("round-trips the aggregate and projection", () =>
    Effect.gen(function* () {
      const repository = yield* CollaborativeAcceptanceRepository;
      const input = record();

      yield* repository.save(input);
      const result = yield* repository.getByCaseId({ caseId: input.case.caseId });

      assert.isTrue(Option.isSome(result));
      if (Option.isNone(result)) return;
      assert.deepStrictEqual(result.value, input);
    }),
  );

  it.effect("lists cases by assignment without replacing execution state", () =>
    Effect.gen(function* () {
      const repository = yield* CollaborativeAcceptanceRepository;
      const input = record();

      yield* repository.save(input);
      const result = yield* repository.listByAssignmentId({
        assignmentId: input.case.assignmentId,
      });

      assert.deepStrictEqual(
        result.map(({ projection }) => projection.acceptanceStatus),
        ["awaiting-review"],
      );
    }),
  );

  it.effect("keeps prior candidates immutable when a new review epoch is saved", () =>
    Effect.gen(function* () {
      const repository = yield* CollaborativeAcceptanceRepository;
      const input = record();
      const nextCandidate = {
        ...input.case.currentCandidate,
        candidateId: CollaborativeAcceptanceCandidateId.make("candidate-repository-b"),
        reviewEpoch: 2,
        headSha: "sha-repository-b",
        createdAt: "2026-09-19T00:01:00.000Z",
      };
      const advanced = advanceAcceptanceCandidate(input.case, nextCandidate);
      assert.isTrue(advanced.ok);
      if (!advanced.ok) return;

      yield* repository.save({
        ...input,
        case: advanced.acceptanceCase,
        candidates: [...input.candidates, nextCandidate],
        projection: {
          ...input.projection,
          candidateId: nextCandidate.candidateId,
          headSha: nextCandidate.headSha,
          updatedAt: nextCandidate.createdAt,
        },
      });

      const result = yield* repository.getByCaseId({ caseId: input.case.caseId });
      assert.isTrue(Option.isSome(result));
      if (Option.isNone(result)) return;
      assert.deepStrictEqual(
        result.value.candidates.map((candidate) => candidate.headSha),
        ["sha-repository", "sha-repository-b"],
      );
    }),
  );
});
