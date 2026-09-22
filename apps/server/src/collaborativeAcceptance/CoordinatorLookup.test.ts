import { assert, it } from "@effect/vitest";
import {
  CollaborativeAcceptanceCaseId,
  ProjectId,
  ThreadId,
  type CollaborativeAcceptanceRecord,
  type PullRequestRef,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import {
  CollaborativeAcceptanceCoordinatorLive,
  CollaborativeAcceptanceCoordinator as CoordinatorService,
} from "./Coordinator.ts";
import { CollaborativeAcceptanceRepository } from "../persistence/Services/CollaborativeAcceptance.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const pullRequest: PullRequestRef = {
  projectId: ProjectId.make("project-lookup"),
  repository: "owner/repository",
  number: 42,
};

const currentRecord = {
  revision: 0,
  case: {
    caseId: CollaborativeAcceptanceCaseId.make("case-service-current"),
    assignmentId: "assignment-service-current",
    parentThreadId: ThreadId.make("thread-service"),
    pullRequest,
    contractRevision: "contract-1",
    currentCandidate: {
      candidateId: "candidate-service-current",
      reviewEpoch: 1,
      headSha: "head-service-current",
      contractRevision: "contract-1",
      reviewWorkflow: { identity: "workflow", version: "1" },
      createdAt: "2026-09-20T00:00:00.000Z",
    },
    criteria: [],
    policy: {
      automation: "off",
      reviewTrigger: "manual",
      reviewWorkflow: { identity: "workflow", version: "1" },
      commentPolicy: "blocking-only",
      budgets: {
        exchanges: 0,
        modelSpendCents: 0,
        retries: 0,
        disputeRounds: 0,
        executionDurationSeconds: 0,
        waitingDeadlineSeconds: 0,
      },
    },
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  },
  candidates: [],
  evidence: [],
  assessments: [],
  exchanges: [],
  projection: {
    caseId: CollaborativeAcceptanceCaseId.make("case-service-current"),
    candidateId: "candidate-service-current",
    headSha: "head-service-current",
    executionPhase: "monitoring",
    collaborationStatus: "none",
    acceptanceLifecycle: "awaiting-review",
    readiness: "blocked",
    reasons: [],
    staleAssessmentIds: [],
    updatedAt: "2026-09-20T00:00:00.000Z",
  },
} as unknown as CollaborativeAcceptanceRecord;

const repository = {
  save: () => Effect.die("unused"),
  getByCaseId: () => Effect.succeed(Option.some(currentRecord)),
  listByAssignmentId: () => Effect.succeed([currentRecord]),
  listByParentThreadId: () => Effect.succeed([currentRecord]),
  listAll: () => Effect.succeed([currentRecord]),
};

const testLayer = CollaborativeAcceptanceCoordinatorLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(CollaborativeAcceptanceRepository, repository),
      Layer.succeed(OrchestrationEngineService, {} as OrchestrationEngineShape),
      Layer.succeed(ProjectionSnapshotQuery, {} as ProjectionSnapshotQueryShape),
      ServerSettingsService.layerTest(),
    ),
  ),
);

it.effect("uses deterministic and parent-thread lookups instead of scanning all cases", () => {
  let parentThreadLookupCount = 0;
  const targetedRepository = {
    ...repository,
    getByCaseId: () => Effect.succeed(Option.none()),
    listByParentThreadId: () =>
      Effect.sync(() => {
        parentThreadLookupCount += 1;
        return [];
      }),
    listAll: () => Effect.die("automatic reconciliation must not scan all cases"),
  };
  const targetedLayer = CollaborativeAcceptanceCoordinatorLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(CollaborativeAcceptanceRepository, targetedRepository),
        Layer.succeed(OrchestrationEngineService, {} as OrchestrationEngineShape),
        Layer.succeed(ProjectionSnapshotQuery, {} as ProjectionSnapshotQueryShape),
        ServerSettingsService.layerTest(),
      ),
    ),
  );

  return Effect.gen(function* () {
    const coordinator = yield* CoordinatorService;
    const result = yield* coordinator.reconcileAutomaticCandidate({
      parentThreadId: ThreadId.make("thread-service"),
      pullRequest,
      headSha: "head-current",
      sourceRevision: "monitor-current",
    });

    assert.isNull(result.record);
    assert.strictEqual(parentThreadLookupCount, 1);
  }).pipe(Effect.provide(targetedLayer));
});

it.effect("resolves the current case and includes its durable status", () =>
  Effect.gen(function* () {
    const coordinator = yield* CoordinatorService;
    const result = yield* coordinator.resolveForPullRequest({
      threadId: ThreadId.make("thread-service"),
      pullRequest,
    });

    assert.equal(result.caseId, currentRecord.case.caseId);
    assert.equal(result.status.record?.case.caseId, currentRecord.case.caseId);
    assert.equal(result.status.record?.case.currentCandidate.headSha, "head-service-current");
  }).pipe(Effect.provide(testLayer)),
);
