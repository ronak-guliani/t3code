import {
  CollaborativeAcceptanceCandidateId,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceError,
  CollaborativeAcceptanceExecutionId,
  CollaborativeAcceptanceExchangeId,
  CollaborativeAcceptanceObligation,
  CollaborativeAcceptanceProvenance,
  CollaborativeAcceptanceStatus,
  CollaborationDelivery,
  CollaborationRequestId,
  CollaborationResponseId,
  CommandId,
  MessageId,
  type CollaborativeAcceptanceAssessment,
  type CollaborativeAcceptanceCandidate,
  type CollaborativeAcceptanceCandidateSubmission,
  type CollaborativeAcceptanceCase,
  type CollaborativeAcceptanceExchange,
  type CollaborativeAcceptancePauseReason,
  type CollaborativeAcceptanceRecord,
  type CollaborationExecutionAuthority,
  type CollaborationPayloadReference,
  type OrchestrationEvent,
  type PullRequestMonitorFeedbackReportDisposition,
  type PullRequestMonitorFeedbackItemId,
  PullRequestMonitorFeedbackRevisionId,
  PullRequestMonitorReviewCandidate,
  type PullRequestMonitorSnapshot,
  type PullRequestRef,
  type ThreadId,
  TurnId,
  QueuedTurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Crypto from "node:crypto";

import {
  advanceAcceptanceCandidate,
  cancelExchange,
  evaluateAcceptance,
  reserveExchange,
  retryExchange,
  recordExchangeOutcome,
  completeExchange,
  startExchange,
} from "./domain.ts";
import { CollaborativeAcceptanceRepository } from "../persistence/Services/CollaborativeAcceptance.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandWorktreeCleanupPendingError,
} from "../orchestration/Errors.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { QueuedTurnReactor } from "../orchestration/Services/QueuedTurnReactor.ts";
import { PullRequestMonitorService } from "../pullRequestMonitor/PullRequestMonitorService.ts";
import {
  reviewCandidateEligibility,
  type ReviewCandidateMode,
} from "../pullRequestMonitor/reviewCandidate.ts";
import {
  retryReconciliationCas,
  runReconciliationBatch,
  runReconciliationTick,
} from "./reconciliation.ts";

const hash = (parts: ReadonlyArray<string>) =>
  Crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);

const now = () => new Date().toISOString();
const decodeReviewCandidateSchema = Schema.decodeUnknownEffect(PullRequestMonitorReviewCandidate);
const decodeCollaborationDeliverySchema = Schema.decodeUnknownEffect(CollaborationDelivery);
const isCollaborativeAcceptanceError = Schema.is(CollaborativeAcceptanceError);
const isInvariantCommandError = Schema.is(OrchestrationCommandInvariantError);
const isPreviouslyRejectedCommandError = Schema.is(OrchestrationCommandPreviouslyRejectedError);
const isWorktreeCleanupPendingCommandError = Schema.is(
  OrchestrationCommandWorktreeCleanupPendingError,
);

const acceptanceError = (
  message: string,
  input: {
    readonly caseId?: CollaborativeAcceptanceCaseId;
    readonly reason?: CollaborativeAcceptancePauseReason;
  } = {},
) =>
  new CollaborativeAcceptanceError({
    message,
    ...(input.caseId === undefined ? {} : { caseId: input.caseId }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });

const hasCompleteAuthority = (authority: CollaborationExecutionAuthority): boolean =>
  authority.executionId.trim().length > 0 &&
  authority.assignmentId !== undefined &&
  authority.assignmentId.trim().length > 0 &&
  authority.generation > 0 &&
  authority.dispatchId !== null &&
  authority.dispatchId.trim().length > 0 &&
  authority.turnId !== null &&
  authority.turnId.trim().length > 0;

const bindAuthority = (
  authority: CollaborationExecutionAuthority,
  threadId: ThreadId,
): CollaborationExecutionAuthority => ({
  ...authority,
  threadId,
});

const requireCompleteAuthority = (
  authority: CollaborationExecutionAuthority,
  caseId?: CollaborativeAcceptanceCaseId,
) =>
  hasCompleteAuthority(authority)
    ? Effect.succeed(authority)
    : Effect.fail(
        acceptanceError(
          "Acceptance mutations require a complete authenticated execution authority.",
          {
            ...(caseId === undefined ? {} : { caseId }),
            reason: "contradictory-contract",
          },
        ),
      );

const executionFor = (
  caseId: CollaborativeAcceptanceCaseId,
  candidateId: CollaborativeAcceptanceCandidateId,
  mode: ReviewCandidateMode,
) => CollaborativeAcceptanceExecutionId.make(`acceptance:${hash([caseId, candidateId, mode])}`);

const exchangeFor = (
  caseId: CollaborativeAcceptanceCaseId,
  candidateId: CollaborativeAcceptanceCandidateId,
  mode: ReviewCandidateMode,
) => CollaborativeAcceptanceExchangeId.make(`exchange:${hash([caseId, candidateId, mode])}`);

const requestFor = (exchangeId: CollaborativeAcceptanceExchangeId) =>
  CollaborationRequestId.make(`acceptance-request:${exchangeId}`);

const queuedTurnFor = (requestId: CollaborationRequestId) =>
  QueuedTurnId.make(`acceptance-queued:${requestId}`);

const messageFor = (requestId: CollaborationRequestId) =>
  MessageId.make(`acceptance-message:${requestId}`);

const commandFor = (name: string, identity: string) =>
  CommandId.make(`acceptance:${name}:${identity}`);

const payloadFor = (
  provenance: CollaborativeAcceptanceProvenance,
): CollaborationPayloadReference => {
  const serialized = JSON.stringify(provenance);
  return {
    ref: `acceptance://${provenance.caseId}/${provenance.candidateId}`,
    sha256: Crypto.createHash("sha256").update(serialized).digest("hex"),
  };
};

const samePullRequest = (
  thread: { readonly pullRequest?: { readonly number: number; readonly url: string } | null },
  reference: PullRequestRef,
) =>
  thread.pullRequest?.number === reference.number &&
  (thread.pullRequest.url.includes(`/${reference.repository}/`) ||
    thread.pullRequest.url.endsWith(`/${reference.repository}`));

const reviewPrompt = (input: {
  readonly provenance: CollaborativeAcceptanceProvenance;
  readonly candidate: CollaborativeAcceptanceCandidate;
  readonly pullRequest: PullRequestRef;
  readonly mode: ReviewCandidateMode;
}) =>
  [
    "Collaborative Acceptance review request.",
    `Review mode: ${input.mode}.`,
    `Pull request: ${input.pullRequest.repository}#${input.pullRequest.number}.`,
    "Immutable provenance (do not infer or replace these values):",
    JSON.stringify(input.provenance),
    `Candidate head: ${input.candidate.headSha}.`,
    `Contract revision: ${input.candidate.contractRevision}.`,
    `Workflow: ${input.candidate.reviewWorkflow.identity}@${input.candidate.reviewWorkflow.version}.`,
    "Return findings through pr_monitor_submit_findings and then respond to this request.",
  ].join("\n");

export interface AcceptanceAuthorityInput {
  readonly assignmentId: string;
  readonly senderAuthority: CollaborationExecutionAuthority;
  readonly recipientThreadId: ThreadId;
  readonly recipientAuthority: CollaborationExecutionAuthority;
}

export interface CollaborativeAcceptanceCoordinatorShape {
  readonly submitCandidate: (
    input: CollaborativeAcceptanceCandidateSubmission &
      AcceptanceAuthorityInput & { readonly senderThreadId: ThreadId },
  ) => Effect.Effect<CollaborativeAcceptanceStatus, CollaborativeAcceptanceError>;
  readonly requestReview: (
    input: AcceptanceAuthorityInput & {
      readonly senderThreadId: ThreadId;
      readonly caseId: CollaborativeAcceptanceCaseId;
    },
  ) => Effect.Effect<CollaborativeAcceptanceStatus, CollaborativeAcceptanceError>;
  readonly requestCollaboration: (input: {
    readonly senderThreadId: ThreadId;
    readonly recipientThreadId: ThreadId;
    readonly senderAuthority: CollaborationExecutionAuthority;
    readonly recipientAuthority: CollaborationExecutionAuthority;
    readonly assignmentId: string;
    readonly caseId?: CollaborativeAcceptanceCaseId;
    readonly kind: "clarification" | "decision";
    readonly text: string;
  }) => Effect.Effect<void, CollaborativeAcceptanceError>;
  readonly respondToRequest: (input: {
    readonly responderThreadId: ThreadId;
    readonly requestId: CollaborationRequestId;
    readonly responseAuthority: CollaborationExecutionAuthority;
    readonly text: string;
    readonly outcome: "completed" | "cancelled" | "needs-human";
  }) => Effect.Effect<void, CollaborativeAcceptanceError>;
  readonly dispositionFinding: (input: {
    readonly caseId: CollaborativeAcceptanceCaseId;
    readonly reference: PullRequestRef;
    readonly itemId: PullRequestMonitorFeedbackItemId;
    readonly disposition: PullRequestMonitorFeedbackReportDisposition;
    readonly note?: string;
    readonly reporterThreadId: ThreadId;
  }) => Effect.Effect<unknown, CollaborativeAcceptanceError>;
  readonly submitAssessment: (input: {
    readonly caseId: CollaborativeAcceptanceCaseId;
    readonly assessment: CollaborativeAcceptanceAssessment;
    readonly authority?: CollaborationExecutionAuthority;
  }) => Effect.Effect<CollaborativeAcceptanceStatus, CollaborativeAcceptanceError>;
  readonly recordProviderEvidence: (input: {
    readonly caseId: CollaborativeAcceptanceCaseId;
    readonly evidence: NonNullable<CollaborativeAcceptanceRecord["providerEvidence"]>;
  }) => Effect.Effect<CollaborativeAcceptanceStatus, CollaborativeAcceptanceError>;
  readonly refreshProviderEvidence: (
    caseId: CollaborativeAcceptanceCaseId,
  ) => Effect.Effect<CollaborativeAcceptanceStatus, CollaborativeAcceptanceError>;
  readonly status: (
    caseId: CollaborativeAcceptanceCaseId,
  ) => Effect.Effect<CollaborativeAcceptanceStatus, CollaborativeAcceptanceError>;
  readonly pause: (
    caseId: CollaborativeAcceptanceCaseId,
    reason: CollaborativeAcceptancePauseReason,
    authority?: CollaborationExecutionAuthority,
  ) => Effect.Effect<CollaborativeAcceptanceStatus, CollaborativeAcceptanceError>;
  readonly resume: (
    caseId: CollaborativeAcceptanceCaseId,
    authority?: CollaborationExecutionAuthority,
  ) => Effect.Effect<CollaborativeAcceptanceStatus, CollaborativeAcceptanceError>;
  readonly start: () => Effect.Effect<
    void,
    CollaborativeAcceptanceError,
    import("effect/Scope").Scope
  >;
}

const makeCoordinator = Effect.gen(function* () {
  const repository = yield* CollaborativeAcceptanceRepository;
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const queuedTurns = yield* Effect.serviceOption(QueuedTurnReactor);
  const monitors = yield* Effect.serviceOption(PullRequestMonitorService);
  const started = yield* Ref.make(false);
  const dirtyReconciliationCases = yield* Ref.make<ReadonlySet<CollaborativeAcceptanceCaseId>>(
    new Set(),
  );
  const reconciliationLocks = new Map<string, Semaphore.Semaphore>();

  const withReconciliationLock = <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    let lock = reconciliationLocks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      reconciliationLocks.set(key, lock);
    }
    return lock.withPermit(effect);
  };

  const load = (caseId: CollaborativeAcceptanceCaseId) =>
    repository.getByCaseId({ caseId }).pipe(
      Effect.mapError(() => acceptanceError("Could not load the acceptance case.", { caseId })),
      Effect.flatMap((record) =>
        Option.isSome(record)
          ? Effect.succeed(record.value)
          : Effect.fail(acceptanceError("Acceptance case not found.", { caseId })),
      ),
    );

  const save = (input: {
    readonly record: CollaborativeAcceptanceRecord;
    readonly expectedRevision: number | null;
  }) =>
    repository
      .save(input)
      .pipe(Effect.mapError(() => acceptanceError("Acceptance case changed concurrently; retry.")));

  const isCasConflict = (error: unknown): boolean =>
    isCollaborativeAcceptanceError(error) &&
    error.message === "Acceptance case changed concurrently; retry.";

  const retryCasConflict = <A>(effect: Effect.Effect<A, CollaborativeAcceptanceError>) =>
    retryReconciliationCas(effect, isCasConflict);

  const retainDirtyCase = (caseId: CollaborativeAcceptanceCaseId) =>
    Ref.update(
      dirtyReconciliationCases,
      (cases) => new Set([...cases, caseId]) as ReadonlySet<CollaborativeAcceptanceCaseId>,
    );

  const reconcileSafely = <A, E, R>(
    caseId: CollaborativeAcceptanceCaseId,
    key: string,
    label: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    withReconciliationLock(key, effect).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (isCasConflict(error)) {
            yield* retainDirtyCase(caseId);
          }
          yield* Effect.logWarning(label, {
            caseId,
            error: isCasConflict(error)
              ? acceptanceError("Acceptance reconciliation retry budget exhausted.", {
                  caseId,
                  reason: "ambiguous-outcome",
                })
              : error,
          });
        }),
      ),
    );

  const currentProjection = (
    record: CollaborativeAcceptanceRecord,
    executionPhase: CollaborativeAcceptanceRecord["projection"]["executionPhase"] = "verifying",
    pauseReason?: CollaborativeAcceptancePauseReason | null,
  ) => {
    const effectivePauseReason =
      pauseReason === undefined ? record.projection.pauseReason : pauseReason;
    const obligations = (record.obligations ?? [])
      .filter(
        (obligation) =>
          obligation.status === "open" ||
          obligation.status === "cancelled" ||
          obligation.status === "superseded" ||
          obligation.status === "unavailable" ||
          obligation.status === "failed" ||
          obligation.status === "needs-human",
      )
      .map((obligation) => obligation.obligationId);
    const evaluation = evaluateAcceptance({
      case: record.case,
      candidate: record.case.currentCandidate,
      executionPhase:
        effectivePauseReason === undefined || effectivePauseReason === null
          ? executionPhase
          : "paused",
      providerEvidence: record.providerEvidence ?? null,
      evidence: record.evidence,
      assessments: record.assessments,
      collaborationObligations: obligations,
      updatedAt: now(),
    });
    return {
      ...evaluation.projection,
      ...(effectivePauseReason === undefined || effectivePauseReason === null
        ? {}
        : { pauseReason: effectivePauseReason }),
      ...(record.exchanges.find(
        (exchange) => exchange.status === "reserved" || exchange.status === "committed",
      )?.exchangeId === undefined
        ? {}
        : {
            activeExchangeId: record.exchanges.find(
              (exchange) => exchange.status === "reserved" || exchange.status === "committed",
            )?.exchangeId,
          }),
    };
  };

  const invalidateProviderEvidence = (
    record: CollaborativeAcceptanceRecord,
    reason: CollaborativeAcceptancePauseReason = "provider-failure",
  ) => {
    const withoutEvidence = {
      ...record,
      providerEvidence: null,
      projection: currentProjection({ ...record, providerEvidence: null }, "paused", reason),
      case: { ...record.case, updatedAt: now() },
    };
    return save({ record: withoutEvidence, expectedRevision: record.revision });
  };

  const wakeThread = (threadId: ThreadId): Effect.Effect<void, never> =>
    Option.match(queuedTurns, {
      onNone: () => Effect.void,
      onSome: (reactor) =>
        reactor.wakeThread === undefined ? Effect.void : reactor.wakeThread(threadId),
    });

  const addBlockingObligation = (
    record: CollaborativeAcceptanceRecord,
    input: {
      readonly requestId: CollaborationRequestId;
      readonly ownerThreadId: ThreadId;
    },
  ): ReadonlyArray<CollaborativeAcceptanceObligation> => {
    const obligations = record.obligations ?? [];
    if (obligations.some((obligation) => obligation.requestId === input.requestId)) {
      return obligations;
    }
    return [
      ...obligations,
      {
        obligationId: `obligation:${input.requestId}`,
        requestId: input.requestId,
        caseId: record.case.caseId,
        ownerThreadId: input.ownerThreadId,
        status: "open",
        createdAt: now(),
        resolvedAt: null,
      },
    ];
  };

  const resolveObligation = (
    record: CollaborativeAcceptanceRecord,
    requestId: CollaborationRequestId,
    status:
      | "satisfied"
      | "cancelled"
      | "superseded"
      | "unavailable"
      | "failed"
      | "needs-human"
      | "disposed",
  ): ReadonlyArray<CollaborativeAcceptanceObligation> =>
    (record.obligations ?? []).map((obligation) =>
      obligation.requestId === requestId && obligation.status === "open"
        ? { ...obligation, status, resolvedAt: now() }
        : obligation,
    );

  const obligationStatusForTerminalOutcome = (
    outcome: string | null,
  ): "satisfied" | "cancelled" | "superseded" | "unavailable" | "failed" | "needs-human" => {
    switch (outcome) {
      case "completed":
        return "satisfied";
      case "cancelled":
        return "cancelled";
      case "superseded":
      case "stale":
        return "superseded";
      case "needs-human":
        return "needs-human";
      case "unavailable":
        return "unavailable";
      case "failed":
      case "rejected":
      default:
        return "failed";
    }
  };

  const enforceLimits = (record: CollaborativeAcceptanceRecord) => {
    const active = record.exchanges.find(
      (exchange) => exchange.status === "reserved" || exchange.status === "committed",
    );
    const currentTime = Date.parse(now());
    const budgets = record.case.policy.budgets;
    let reason: CollaborativeAcceptancePauseReason | undefined;
    if (
      active?.status === "committed" &&
      active.startedAt !== null &&
      budgets.executionDurationSeconds > 0 &&
      currentTime - Date.parse(active.startedAt) >= budgets.executionDurationSeconds * 1000
    ) {
      reason = "duration-limit";
    } else if (
      active !== undefined &&
      budgets.waitingDeadlineSeconds > 0 &&
      currentTime - Date.parse(active.startedAt ?? active.reservedAt) >=
        budgets.waitingDeadlineSeconds * 1000
    ) {
      reason = "waiting-deadline";
    } else if (
      record.assessments.filter(
        (assessment) =>
          assessment.role === "parent-reviewer" &&
          assessment.outcome !== "pass" &&
          assessment.outcome !== "acknowledged",
      ).length > 0 &&
      record.assessments.filter(
        (assessment) =>
          assessment.role === "parent-reviewer" &&
          assessment.outcome !== "pass" &&
          assessment.outcome !== "acknowledged",
      ).length >= budgets.disputeRounds
    ) {
      reason = "dispute-limit";
    }
    if (reason === undefined || record.projection.pauseReason === reason) {
      return Effect.succeed(record);
    }
    const next = {
      ...record,
      projection: currentProjection(record, "paused", reason),
      case: { ...record.case, updatedAt: now() },
    };
    return save({ record: next, expectedRevision: record.revision });
  };

  const status = (caseId: CollaborativeAcceptanceCaseId) =>
    load(caseId).pipe(
      Effect.flatMap(enforceLimits),
      Effect.map((record) => ({
        record,
        pauseReason: record.projection.pauseReason ?? null,
      })),
    );

  const enforceLimitsFresh = (caseId: CollaborativeAcceptanceCaseId) =>
    retryCasConflict(load(caseId).pipe(Effect.flatMap(enforceLimits)));

  const decodeReviewCandidate = (
    candidate: CollaborativeAcceptanceCandidate,
    caseId: CollaborativeAcceptanceCaseId,
  ) =>
    decodeReviewCandidateSchema(candidate.reviewCandidate).pipe(
      Effect.mapError(() =>
        acceptanceError("Candidate review metadata is unavailable or invalid.", {
          caseId,
          reason: "contradictory-contract",
        }),
      ),
    );

  const persistCandidate = (input: {
    readonly submission: CollaborativeAcceptanceCandidateSubmission;
    readonly senderThreadId: ThreadId;
    readonly recipientThreadId: ThreadId;
    readonly senderAuthority: CollaborationExecutionAuthority;
  }) =>
    Effect.gen(function* () {
      const caseId =
        input.submission.caseId ??
        CollaborativeAcceptanceCaseId.make(`acceptance:${input.submission.assignmentId}`);
      yield* requireCompleteAuthority(input.senderAuthority, caseId);
      const expectedProvenance: CollaborativeAcceptanceProvenance = {
        assignmentId: input.submission.assignmentId,
        dispatchId: input.senderAuthority.dispatchId,
        turnId: input.senderAuthority.turnId,
        generation: input.senderAuthority.generation,
        caseId,
        candidateId: input.submission.candidate.candidateId,
        headSha: input.submission.candidate.headSha,
        contractRevision: input.submission.candidate.contractRevision,
        reviewWorkflow: input.submission.candidate.reviewWorkflow,
      };
      if (
        input.senderAuthority.assignmentId !== input.submission.assignmentId ||
        (input.submission.candidate.provenance !== undefined &&
          JSON.stringify(input.submission.candidate.provenance) !==
            JSON.stringify(expectedProvenance))
      ) {
        return yield* acceptanceError(
          "Candidate provenance does not match authenticated execution.",
          {
            caseId,
            reason: "contradictory-contract",
          },
        );
      }
      const candidate = {
        ...input.submission.candidate,
        reviewCandidate: input.submission.reviewCandidate,
        provenance: expectedProvenance,
      };
      const reviewCandidate = input.submission.reviewCandidate;
      if (
        reviewCandidate.caseId !== caseId ||
        reviewCandidate.candidateId !== candidate.candidateId ||
        reviewCandidate.reviewEpoch !== candidate.reviewEpoch ||
        reviewCandidate.headSha !== candidate.headSha ||
        reviewCandidate.contractRevision !== candidate.contractRevision ||
        reviewCandidate.reviewWorkflow.identity !== candidate.reviewWorkflow.identity ||
        reviewCandidate.reviewWorkflow.version !== candidate.reviewWorkflow.version
      ) {
        return yield* acceptanceError(
          "Review-candidate provenance does not match the submitted candidate.",
          { caseId, reason: "contradictory-contract" },
        );
      }
      for (const evidence of input.submission.initialEvidence) {
        if (
          evidence.caseId !== caseId ||
          evidence.candidateId !== candidate.candidateId ||
          evidence.headSha !== candidate.headSha ||
          !evidence.current ||
          !evidence.complete
        ) {
          return yield* acceptanceError(
            "Initial evidence must be complete, current, and bound to the submitted case, candidate, and head.",
            { caseId, reason: "contradictory-contract" },
          );
        }
      }
      if (input.submission.initialEvidence.length === 0) {
        return yield* acceptanceError("A candidate requires initial evidence.", {
          caseId,
          reason: "contradictory-contract",
        });
      }

      const caller = yield* projections.getThreadDetailById(input.senderThreadId).pipe(
        Effect.mapError(() =>
          acceptanceError("Could not resolve the submitting thread.", { caseId }),
        ),
        Effect.flatMap((thread) =>
          Option.isSome(thread)
            ? Effect.succeed(thread.value)
            : Effect.fail(acceptanceError("Submitting thread no longer exists.", { caseId })),
        ),
      );
      if (!samePullRequest(caller, input.submission.pullRequest)) {
        return yield* acceptanceError(
          "Candidate submission requires an explicit durable pull-request association.",
          { caseId, reason: "contradictory-contract" },
        );
      }

      const existing = yield* repository
        .getByCaseId({ caseId })
        .pipe(
          Effect.mapError(() => acceptanceError("Could not load the acceptance case.", { caseId })),
        );
      if (Option.isNone(existing)) {
        const acceptanceCase: CollaborativeAcceptanceCase = {
          caseId,
          assignmentId: input.submission.assignmentId,
          parentThreadId: input.recipientThreadId,
          pullRequest: input.submission.pullRequest,
          contractRevision: candidate.contractRevision,
          currentCandidate: candidate,
          criteria: input.submission.criteria,
          policy: input.submission.policy,
          createdAt: candidate.createdAt,
          updatedAt: candidate.createdAt,
        };
        const baseProjection = {
          caseId,
          candidateId: candidate.candidateId,
          headSha: candidate.headSha,
          executionPhase: "verifying" as const,
          collaborationStatus: "child-assessment-pending" as const,
          acceptanceLifecycle: "pending" as const,
          readiness: "no-known-blockers" as const,
          reasons: [],
          staleAssessmentIds: [],
          updatedAt: candidate.createdAt,
        };
        const record: CollaborativeAcceptanceRecord = {
          revision: 0,
          case: acceptanceCase,
          candidates: [candidate],
          evidence: input.submission.initialEvidence,
          assessments: [],
          exchanges: [],
          projection: currentProjection({
            revision: 0,
            case: acceptanceCase,
            candidates: [candidate],
            evidence: input.submission.initialEvidence,
            assessments: [],
            exchanges: [],
            projection: baseProjection,
          }),
        };
        return yield* Effect.succeed({ record, expectedRevision: null });
      }

      const record = existing.value;
      if (
        record.case.assignmentId !== input.submission.assignmentId ||
        record.case.pullRequest.repository !== input.submission.pullRequest.repository ||
        record.case.pullRequest.number !== input.submission.pullRequest.number ||
        record.case.contractRevision !== candidate.contractRevision ||
        record.case.policy.reviewWorkflow.identity !== candidate.reviewWorkflow.identity ||
        record.case.policy.reviewWorkflow.version !== candidate.reviewWorkflow.version ||
        record.case.policy.commentPolicy !== input.submission.policy.commentPolicy ||
        record.case.policy.reviewTrigger !== input.submission.policy.reviewTrigger ||
        record.case.policy.automation !== input.submission.policy.automation ||
        JSON.stringify(record.case.policy.budgets) !==
          JSON.stringify(input.submission.policy.budgets)
      ) {
        return yield* acceptanceError(
          "Candidate provenance does not match the durable acceptance contract.",
          { caseId, reason: "contradictory-contract" },
        );
      }
      const transition = advanceAcceptanceCandidate(record.case, candidate);
      if (!transition.ok) {
        return yield* acceptanceError("Candidate review epoch must increase.", {
          caseId,
          reason: "contradictory-contract",
        });
      }
      return {
        record: {
          ...record,
          case: transition.acceptanceCase,
          candidates: record.candidates.some((entry) => entry.candidateId === candidate.candidateId)
            ? record.candidates
            : [...record.candidates, candidate],
          evidence: [...record.evidence, ...input.submission.initialEvidence],
        },
        expectedRevision: record.revision,
      };
    });

  const admitReview = (input: {
    readonly record: CollaborativeAcceptanceRecord;
    readonly candidate: CollaborativeAcceptanceCandidate;
    readonly reviewCandidate: PullRequestMonitorReviewCandidate;
    readonly mode: ReviewCandidateMode;
    readonly authority: AcceptanceAuthorityInput;
    readonly pullRequest: PullRequestRef;
    readonly senderThreadId: ThreadId;
    readonly force: boolean;
  }) =>
    Effect.gen(function* () {
      const caseId = input.record.case.caseId;
      yield* requireCompleteAuthority(input.authority.senderAuthority, caseId);
      yield* requireCompleteAuthority(input.authority.recipientAuthority, caseId);
      if (input.authority.assignmentId !== input.record.case.assignmentId) {
        return yield* acceptanceError("Acceptance assignment does not match the durable case.", {
          caseId,
          reason: "contradictory-contract",
        });
      }
      const exchangeId = exchangeFor(caseId, input.candidate.candidateId, input.mode);
      const senderAuthority = bindAuthority(input.authority.senderAuthority, input.senderThreadId);
      const recipientAuthority = bindAuthority(
        input.authority.recipientAuthority,
        input.authority.recipientThreadId,
      );
      const requestId = requestFor(exchangeId);
      const equivalent = input.record.exchanges.find(
        (exchange) => exchange.exchangeId === exchangeId,
      );
      if (
        equivalent !== undefined &&
        equivalent.status !== "cancelled" &&
        equivalent.status !== "outcome-recorded"
      ) {
        return input.record;
      }
      if (equivalent !== undefined && !input.force) {
        return input.record;
      }

      if (input.record.projection.pauseReason !== undefined) {
        return input.record;
      }

      if (
        !input.force &&
        (input.record.case.policy.automation === "off" ||
          input.record.case.policy.reviewTrigger === "manual")
      ) {
        return input.record;
      }

      const previousCandidate = input.record.candidates.at(-2);
      const previousReviewCandidate =
        previousCandidate === undefined
          ? null
          : yield* decodeReviewCandidate(previousCandidate, caseId);
      if (
        !reviewCandidateEligibility({
          candidate: input.reviewCandidate,
          previous: previousReviewCandidate,
        }).eligible
      ) {
        return input.record;
      }

      if (
        input.reviewCandidate.previousFindingVerification.required &&
        !input.reviewCandidate.previousFindingVerification.complete
      ) {
        return yield* acceptanceError(
          "Previous finding obligations must be verified before a new review is admitted.",
          { caseId, reason: "contradictory-contract" },
        );
      }

      const provenance = input.candidate.provenance;
      if (provenance === undefined || provenance.caseId !== caseId) {
        return yield* acceptanceError("Review provenance is missing or does not match the case.", {
          caseId,
          reason: "contradictory-contract",
        });
      }
      const exchange: CollaborativeAcceptanceExchange = {
        exchangeId,
        caseId,
        executionId: executionFor(caseId, input.candidate.candidateId, input.mode),
        candidateId: input.candidate.candidateId,
        headSha: input.candidate.headSha,
        requestId,
        reviewMode: input.mode,
        status: "reserved",
        retryCount: 0,
        reservedAt: now(),
        startedAt: null,
        outcomeRecordedAt: null,
        completedAt: null,
        cancelledAt: null,
        modelSpendCents: 1,
        ...(equivalent?.retryLineageId === undefined
          ? { retryLineageId: exchangeId }
          : { retryLineageId: equivalent.retryLineageId }),
      };
      const reserved =
        equivalent === undefined
          ? reserveExchange(
              { budget: input.record.case.policy.budgets, exchanges: input.record.exchanges },
              exchange,
            )
          : retryExchange(
              { budget: input.record.case.policy.budgets, exchanges: input.record.exchanges },
              exchangeId,
              now(),
            );
      if (!reserved.ok) {
        return yield* acceptanceError(`Review admission paused: ${reserved.error}.`, {
          caseId,
          reason:
            reserved.error === "retry-budget-exhausted"
              ? "retry-limit"
              : reserved.error === "model-spend-budget-exhausted"
                ? "model-spend-limit"
                : "budget-exhausted",
        });
      }
      const parent = yield* projections.getThreadDetailById(input.authority.recipientThreadId).pipe(
        Effect.mapError(() =>
          acceptanceError("Could not resolve the review recipient.", { caseId }),
        ),
        Effect.flatMap((thread) =>
          Option.isSome(thread)
            ? Effect.succeed(thread.value)
            : Effect.fail(
                acceptanceError("Review recipient is unavailable.", {
                  caseId,
                  reason: "participant-unavailable",
                }),
              ),
        ),
      );
      const previousRequest = parent.collaborationRequests?.find(
        (request) =>
          request.kind === "review" &&
          request.status === "waiting" &&
          request.caseId === caseId &&
          request.findingRefs.length === 0,
      );
      const payloadRef = payloadFor(provenance);
      const delivery = {
        queuedTurnId: queuedTurnFor(requestId),
        message: {
          messageId: messageFor(requestId),
          role: "user" as const,
          text: reviewPrompt({
            provenance,
            candidate: input.candidate,
            pullRequest: input.pullRequest,
            mode: input.mode,
          }),
          attachments: [],
        },
        modelSelection: parent.modelSelection,
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
      };
      const admission = {
        senderThreadId: input.senderThreadId,
        recipientThreadId: input.authority.recipientThreadId,
        kind: "review" as const,
        blocking: true,
        senderAuthority,
        recipientAuthority,
        producingExecution: senderAuthority,
        payloadRef,
        candidateRefs: [input.candidate.candidateId],
        findingRefs: [],
        supersedesRequestId: previousRequest?.requestId ?? null,
        deliveryJson: JSON.stringify(delivery),
        createdAt: now(),
      };
      const obligations = addBlockingObligation(input.record, {
        requestId,
        ownerThreadId: input.senderThreadId,
      });
      const reservedRecord = {
        ...input.record,
        obligations,
        exchanges: reserved.ledger.exchanges.map((item) =>
          item.exchangeId === exchangeId ? { ...item, admission } : item,
        ),
        projection: currentProjection({
          ...input.record,
          obligations,
          exchanges: reserved.ledger.exchanges.map((item) =>
            item.exchangeId === exchangeId ? { ...item, admission } : item,
          ),
        }),
        case: { ...input.record.case, updatedAt: now() },
      };
      const persistedReservation = yield* save({
        record: reservedRecord,
        expectedRevision: input.record.revision,
      });
      const latest = yield* load(caseId);
      if (latest.case.currentCandidate.headSha !== input.candidate.headSha) {
        const cancelled = reservedRecord.exchanges.map((item) =>
          item.exchangeId === exchangeId
            ? { ...item, status: "cancelled" as const, cancelledAt: now() }
            : item,
        );
        yield* save({
          record: {
            ...latest,
            exchanges: cancelled,
            projection: currentProjection({ ...latest, exchanges: cancelled }),
            case: { ...latest.case, updatedAt: now() },
          },
          expectedRevision: latest.revision,
        });
        return yield* acceptanceError("Candidate changed before review dispatch.", {
          caseId,
          reason: "stale-head",
        });
      }
      yield* dispatchAdmission(persistedReservation, exchange);
      return yield* load(caseId);
    });

  const submitCandidate: CollaborativeAcceptanceCoordinatorShape["submitCandidate"] = (input) =>
    Effect.gen(function* () {
      const persistedCandidate = yield* persistCandidate({
        submission: input,
        senderThreadId: input.senderThreadId,
        recipientThreadId: input.recipientThreadId,
        senderAuthority: input.senderAuthority,
      });
      const record = persistedCandidate.record;
      const candidate = record.case.currentCandidate;
      const reviewCandidate = yield* decodeReviewCandidate(candidate, record.case.caseId);
      const previousCandidate = record.candidates.at(-2);
      const previous =
        previousCandidate === undefined
          ? undefined
          : yield* decodeReviewCandidate(previousCandidate, record.case.caseId);
      const eligibility = reviewCandidateEligibility({
        candidate: reviewCandidate,
        ...(previous === undefined ? {} : { previous }),
      });
      const previouslyReviewedEligibleCandidate = record.candidates
        .slice(0, -1)
        .some((entry) =>
          record.exchanges.some(
            (exchange) =>
              exchange.candidateId === entry.candidateId && exchange.status !== "cancelled",
          ),
        );
      const shouldTrigger =
        input.policy.automation !== "off" &&
        (input.policy.automation === "until-ready" ||
          record.exchanges.every((exchange) => exchange.status === "cancelled")) &&
        (input.policy.reviewTrigger === "each-eligible-candidate" ||
          (input.policy.reviewTrigger === "first-candidate" &&
            !previouslyReviewedEligibleCandidate));
      const persisted = yield* save({
        record: {
          ...record,
          projection: currentProjection(record),
          case: { ...record.case, updatedAt: now() },
        },
        expectedRevision: persistedCandidate.expectedRevision,
      });
      if (!shouldTrigger || !eligibility.eligible) {
        return { record: persisted, pauseReason: persisted.projection.pauseReason ?? null };
      }
      const reviewed = yield* admitReview({
        record: persisted,
        candidate,
        reviewCandidate,
        mode: eligibility.mode ?? "full",
        authority: input,
        pullRequest: input.pullRequest,
        senderThreadId: input.senderThreadId,
        force: false,
      });
      return { record: reviewed, pauseReason: reviewed.projection.pauseReason ?? null };
    });

  const requestReview: CollaborativeAcceptanceCoordinatorShape["requestReview"] = (input) =>
    Effect.gen(function* () {
      const record = yield* load(input.caseId).pipe(Effect.flatMap(enforceLimits));
      const reviewCandidate = yield* decodeReviewCandidate(
        record.case.currentCandidate,
        input.caseId,
      );
      const eligibility = reviewCandidateEligibility({ candidate: reviewCandidate });
      if (!eligibility.eligible || eligibility.mode === null) {
        return { record, pauseReason: record.projection.pauseReason ?? null };
      }
      const reviewed = yield* admitReview({
        record,
        candidate: record.case.currentCandidate,
        reviewCandidate,
        mode: eligibility.mode,
        authority: input,
        pullRequest: record.case.pullRequest,
        senderThreadId: input.senderThreadId,
        force: true,
      });
      return { record: reviewed, pauseReason: reviewed.projection.pauseReason ?? null };
    });

  const requestCollaboration: CollaborativeAcceptanceCoordinatorShape["requestCollaboration"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const caseId = input.caseId;
      if (caseId === undefined) {
        return yield* acceptanceError(
          "Acceptance collaboration requests require a durable case binding.",
          { reason: "contradictory-contract" },
        );
      }
      yield* requireCompleteAuthority(input.senderAuthority, caseId);
      yield* requireCompleteAuthority(input.recipientAuthority, caseId);
      const record = yield* load(caseId);
      if (
        input.assignmentId !== record.case.assignmentId ||
        input.senderAuthority.assignmentId !== input.assignmentId ||
        input.recipientAuthority.assignmentId !== input.assignmentId
      ) {
        return yield* acceptanceError("Acceptance assignment does not match the durable case.", {
          caseId,
          reason: "contradictory-contract",
        });
      }
      const exchangeId = CollaborativeAcceptanceExchangeId.make(
        `exchange:${hash([input.assignmentId, input.senderThreadId, input.recipientThreadId, input.kind, input.text])}`,
      );
      const requestId = requestFor(exchangeId);
      if (record.exchanges.some((exchange) => exchange.exchangeId === exchangeId)) {
        return;
      }
      const senderAuthority = bindAuthority(input.senderAuthority, input.senderThreadId);
      const recipientAuthority = bindAuthority(input.recipientAuthority, input.recipientThreadId);
      const recipient = yield* projections.getThreadDetailById(input.recipientThreadId).pipe(
        Effect.mapError(() => acceptanceError("Could not resolve collaboration recipient.")),
        Effect.flatMap((thread) =>
          Option.isSome(thread)
            ? Effect.succeed(thread.value)
            : Effect.fail(
                acceptanceError("Collaboration recipient is unavailable.", {
                  reason: "participant-unavailable",
                }),
              ),
        ),
      );
      const delivery = {
        queuedTurnId: queuedTurnFor(requestId),
        message: {
          messageId: messageFor(requestId),
          role: "user" as const,
          text: input.text,
          attachments: [],
        },
        modelSelection: recipient.modelSelection,
        runtimeMode: recipient.runtimeMode,
        interactionMode: recipient.interactionMode,
      };
      const exchange: CollaborativeAcceptanceExchange = {
        exchangeId,
        caseId,
        executionId: executionFor(caseId, exchangeId, "full"),
        requestId,
        status: "reserved",
        retryCount: 0,
        reservedAt: now(),
        startedAt: null,
        outcomeRecordedAt: null,
        completedAt: null,
        cancelledAt: null,
        modelSpendCents: 1,
      };
      const reserved = reserveExchange(
        { budget: record.case.policy.budgets, exchanges: record.exchanges },
        exchange,
      );
      if (!reserved.ok) {
        return yield* acceptanceError(`Collaboration admission paused: ${reserved.error}.`, {
          caseId,
          reason:
            reserved.error === "model-spend-budget-exhausted"
              ? "model-spend-limit"
              : "budget-exhausted",
        });
      }
      const admission = {
        senderThreadId: input.senderThreadId,
        recipientThreadId: input.recipientThreadId,
        kind: input.kind,
        blocking: true,
        senderAuthority,
        recipientAuthority,
        producingExecution: senderAuthority,
        payloadRef: {
          ref: `collaboration://${requestId}`,
          sha256: Crypto.createHash("sha256").update(input.text).digest("hex"),
        },
        candidateRefs: [],
        findingRefs: [],
        supersedesRequestId: null,
        deliveryJson: JSON.stringify(delivery),
        createdAt: now(),
      };
      const obligations = addBlockingObligation(record, {
        requestId,
        ownerThreadId: input.senderThreadId,
      });
      const reservedRecord = {
        ...record,
        obligations,
        exchanges: reserved.ledger.exchanges.map((item) =>
          item.exchangeId === exchangeId ? { ...item, admission } : item,
        ),
        projection: currentProjection({
          ...record,
          obligations,
          exchanges: reserved.ledger.exchanges.map((item) =>
            item.exchangeId === exchangeId ? { ...item, admission } : item,
          ),
        }),
        case: { ...record.case, updatedAt: now() },
      };
      const persistedReservation = yield* save({
        record: reservedRecord,
        expectedRevision: record.revision,
      });
      yield* dispatchAdmission(persistedReservation, exchange);
    });

  const respondToRequest: CollaborativeAcceptanceCoordinatorShape["respondToRequest"] = (input) =>
    Effect.gen(function* () {
      const readModel = yield* engine.getReadModel();
      const location = readModel.threads
        .flatMap((thread) =>
          (thread.collaborationRequests ?? []).map((request) => ({ thread, request })),
        )
        .find(({ request }) => request.requestId === input.requestId);
      if (location === undefined) {
        return yield* acceptanceError("Collaboration request not found.");
      }
      if (location.request.recipientThreadId !== input.responderThreadId) {
        return yield* acceptanceError("Only the request recipient may respond.");
      }
      const caseId = location.request.caseId;
      const record =
        caseId === undefined
          ? null
          : yield* load(caseId).pipe(
              Effect.mapError(() =>
                acceptanceError("Acceptance exchange could not be loaded.", { caseId }),
              ),
            );
      const admittedAuthority =
        record?.exchanges.find((exchange) => exchange.exchangeId === location.request.exchangeId)
          ?.admission?.recipientAuthority ?? null;
      yield* requireCompleteAuthority(input.responseAuthority, caseId);
      const responseAuthority = bindAuthority(input.responseAuthority, input.responderThreadId);
      if (
        record !== null &&
        (input.responseAuthority.assignmentId !== record.case.assignmentId ||
          location.request.recipientAuthority.assignmentId !== record.case.assignmentId)
      ) {
        return yield* acceptanceError("Response assignment does not match the admitted case.", {
          caseId: record.case.caseId,
          reason: "contradictory-contract",
        });
      }
      if (
        admittedAuthority === null ||
        responseAuthority.executionId !== admittedAuthority.executionId ||
        responseAuthority.assignmentId !== admittedAuthority.assignmentId ||
        responseAuthority.threadId !== admittedAuthority.threadId ||
        responseAuthority.generation !== admittedAuthority.generation ||
        responseAuthority.dispatchId !== admittedAuthority.dispatchId ||
        responseAuthority.turnId !== admittedAuthority.turnId
      ) {
        return yield* acceptanceError("Response authority does not match the admitted request.", {
          reason: "contradictory-contract",
        });
      }
      const sender = yield* projections.getThreadDetailById(location.request.senderThreadId).pipe(
        Effect.mapError(() => acceptanceError("Could not resolve request sender.")),
        Effect.flatMap((thread) =>
          Option.isSome(thread)
            ? Effect.succeed(thread.value)
            : Effect.fail(
                acceptanceError("Request sender is unavailable.", {
                  reason: "participant-unavailable",
                }),
              ),
        ),
      );
      yield* engine
        .dispatch({
          type: "thread.collaboration-request.respond",
          commandId: commandFor("respond", input.requestId),
          threadId: input.responderThreadId,
          requestId: input.requestId,
          responseId: CollaborationResponseId.make(
            `response:${hash([input.requestId, responseAuthority.executionId, input.text])}`,
          ),
          exchangeId: location.request.exchangeId,
          responderAuthority: responseAuthority,
          payloadRef: {
            ref: `collaboration-response://${input.requestId}`,
            sha256: Crypto.createHash("sha256").update(input.text).digest("hex"),
          },
          outcome: input.outcome,
          delivery: {
            queuedTurnId: QueuedTurnId.make(`acceptance-response:${input.requestId}`),
            message: {
              messageId: MessageId.make(`acceptance-response-message:${input.requestId}`),
              role: "user",
              text: input.text,
              attachments: [],
            },
            modelSelection: sender.modelSelection,
            runtimeMode: sender.runtimeMode,
            interactionMode: sender.interactionMode,
          },
          createdAt: now(),
        })
        .pipe(
          Effect.mapError(() => acceptanceError("Collaboration response could not be queued.")),
        );
      if (caseId !== undefined && record !== null) {
        const outcome = recordExchangeOutcome(
          { budget: record.case.policy.budgets, exchanges: record.exchanges },
          location.request.exchangeId,
          now(),
        );
        if (outcome.ok) {
          const next = {
            ...record,
            exchanges: outcome.ledger.exchanges,
            projection: currentProjection({
              ...record,
              exchanges: outcome.ledger.exchanges,
            }),
            case: { ...record.case, updatedAt: now() },
          };
          yield* save({ record: next, expectedRevision: record.revision });
        }
      }
      yield* wakeThread(location.request.senderThreadId);
    });

  const submitAssessment: CollaborativeAcceptanceCoordinatorShape["submitAssessment"] = (input) =>
    Effect.gen(function* () {
      const record = yield* load(input.caseId);
      if (input.authority === undefined) {
        return yield* acceptanceError("Assessment requires authenticated execution authority.", {
          caseId: input.caseId,
          reason: "contradictory-contract",
        });
      }
      yield* requireCompleteAuthority(input.authority, input.caseId);
      if (input.authority.assignmentId !== record.case.assignmentId) {
        return yield* acceptanceError("Assessment assignment does not match the durable case.", {
          caseId: input.caseId,
          reason: "contradictory-contract",
        });
      }
      const candidate = record.case.currentCandidate;
      const assessment = input.assessment;
      if (
        assessment.caseId !== input.caseId ||
        assessment.candidateId !== candidate.candidateId ||
        assessment.headSha !== candidate.headSha ||
        assessment.contractRevision !== candidate.contractRevision ||
        assessment.reviewWorkflow.identity !== candidate.reviewWorkflow.identity ||
        assessment.reviewWorkflow.version !== candidate.reviewWorkflow.version ||
        assessment.outcome === "acknowledged"
      ) {
        return yield* acceptanceError(
          "Assessment provenance does not match the current candidate.",
          {
            caseId: input.caseId,
            reason: "contradictory-contract",
          },
        );
      }
      const next = {
        ...record,
        assessments: record.assessments.some(
          (item) => item.assessmentId === assessment.assessmentId,
        )
          ? record.assessments
          : [...record.assessments, assessment],
      };
      const saved = yield* save({
        record: {
          ...next,
          projection: currentProjection(next),
          case: { ...next.case, updatedAt: now() },
        },
        expectedRevision: record.revision,
      });

      return { record: saved, pauseReason: saved.projection.pauseReason ?? null };
    });

  const providerEvidenceFromSnapshot = (
    record: CollaborativeAcceptanceRecord,
    snapshot: PullRequestMonitorSnapshot,
    unresolvedActionableFindings: number,
    unresolvedReviewThreads: number,
  ) => {
    const coverage = snapshot.requiredCheckCoverage;
    return {
      caseId: record.case.caseId,
      candidateId: record.case.currentCandidate.candidateId,
      headSha: snapshot.headSha,
      sourceId: `${snapshot.provider}:${snapshot.repository}#${snapshot.number}`,
      sourceRevision: snapshot.sourceRevision,
      complete:
        snapshot.completeness.reviewsComplete &&
        snapshot.completeness.reviewThreadsComplete &&
        snapshot.completeness.issueCommentsComplete &&
        snapshot.completeness.checksComplete &&
        snapshot.completeness.requiredChecksKnown &&
        coverage?.completeness === "complete",
      pullRequestState: snapshot.state,
      isDraft: snapshot.isDraft,
      mergeability: snapshot.mergeability,
      reviewEvidenceComplete: snapshot.completeness.reviewsComplete,
      reviewThreadEvidenceComplete: snapshot.completeness.reviewThreadsComplete,
      commentEvidenceComplete: snapshot.completeness.issueCommentsComplete,
      checkEvidenceComplete: snapshot.completeness.checksComplete,
      requiredChecksKnown: snapshot.completeness.requiredChecksKnown,
      requiredChecks: coverage?.observed ?? [],
      ...(coverage === undefined ? {} : { requiredCheckCoverage: coverage }),
      unresolvedActionableFindings,
      unresolvedReviewThreads,
      observedAt: snapshot.fetchedAt,
    };
  };

  const recordProviderEvidence: CollaborativeAcceptanceCoordinatorShape["recordProviderEvidence"] =
    (input) =>
      Effect.gen(function* () {
        const record = yield* load(input.caseId);
        if (
          input.evidence.caseId === undefined ||
          input.evidence.sourceId === undefined ||
          (input.evidence.caseId !== undefined && input.evidence.caseId !== input.caseId) ||
          input.evidence.candidateId !== record.case.currentCandidate.candidateId ||
          input.evidence.headSha !== record.case.currentCandidate.headSha
        ) {
          yield* invalidateProviderEvidence(record, "stale-head");
          return yield* acceptanceError("Provider evidence is stale for the current candidate.", {
            caseId: input.caseId,
            reason: "stale-head",
          });
        }
        const existing = record.providerEvidence;
        const comparable = (
          evidence: NonNullable<CollaborativeAcceptanceRecord["providerEvidence"]>,
        ) => JSON.stringify({ ...evidence, observedAt: null });
        if (
          existing !== undefined &&
          existing !== null &&
          existing.sourceRevision === input.evidence.sourceRevision &&
          comparable(existing) === comparable(input.evidence)
        ) {
          return {
            record,
            pauseReason: record.projection.pauseReason ?? null,
          };
        }
        const next = { ...record, providerEvidence: input.evidence };
        const saved = yield* save({
          record: {
            ...next,
            projection: currentProjection(
              next,
              input.evidence.pullRequestState === "open" ? "monitoring" : "paused",
              input.evidence.pullRequestState === "open" ? undefined : "closed-pull-request",
            ),
            case: { ...next.case, updatedAt: now() },
          },
          expectedRevision: record.revision,
        });
        return { record: saved, pauseReason: saved.projection.pauseReason ?? null };
      });

  const refreshProviderEvidence: CollaborativeAcceptanceCoordinatorShape["refreshProviderEvidence"] =
    (caseId) =>
      Option.match(monitors, {
        onNone: () =>
          load(caseId).pipe(
            Effect.flatMap((record) =>
              invalidateProviderEvidence(record, "participant-unavailable"),
            ),
            Effect.map((record) => ({
              record,
              pauseReason: record.projection.pauseReason ?? null,
            })),
          ),
        onSome: (service) =>
          Effect.gen(function* () {
            const record = yield* load(caseId);
            const context = yield* service.context({ reference: record.case.pullRequest }).pipe(
              Effect.mapError(() =>
                acceptanceError("Authoritative pull-request evidence is unavailable.", {
                  caseId,
                  reason: "provider-failure",
                }),
              ),
            );
            if (context.latestSnapshot === null) {
              return yield* acceptanceError("Provider evidence is unavailable.", {
                caseId,
                reason: "provider-failure",
              });
            }
            if (context.latestSnapshot.headSha !== record.case.currentCandidate.headSha) {
              const withoutEvidence = {
                ...record,
                providerEvidence: null,
                case: { ...record.case, updatedAt: now() },
              };
              const next = {
                ...withoutEvidence,
                projection: currentProjection(withoutEvidence, "verifying"),
              };
              const saved = yield* save({ record: next, expectedRevision: record.revision });
              return { record: saved, pauseReason: saved.projection.pauseReason ?? null };
            }
            const evidence = providerEvidenceFromSnapshot(
              record,
              context.latestSnapshot,
              context.items.filter((item) => item.status !== "closed").length,
              context.latestSnapshot.reviewThreads.filter((thread) => !thread.resolved).length,
            );
            return yield* recordProviderEvidence({ caseId, evidence });
          }).pipe(
            Effect.catch((error) =>
              load(caseId).pipe(
                Effect.flatMap((record) => invalidateProviderEvidence(record)),
                Effect.tap(() =>
                  Effect.logWarning("collaborative-acceptance.provider-evidence-invalidated", {
                    caseId,
                    error,
                  }),
                ),
                Effect.map((record) => ({
                  record,
                  pauseReason: record.projection.pauseReason ?? null,
                })),
              ),
            ),
          ),
      });

  const dispositionFinding: CollaborativeAcceptanceCoordinatorShape["dispositionFinding"] = (
    input,
  ) =>
    Option.match(monitors, {
      onNone: () =>
        Effect.fail(
          acceptanceError("Pull request monitoring is unavailable.", {
            reason: "participant-unavailable",
          }),
        ),
      onSome: (service) =>
        service
          .report({
            reference: input.reference,
            itemId: input.itemId,
            disposition: input.disposition,
            ...(input.note === undefined ? {} : { note: input.note }),
            reporterThreadId: input.reporterThreadId,
          })
          .pipe(
            Effect.mapError(() => acceptanceError("Finding disposition could not be recorded.")),
          ),
    });

  const pause: CollaborativeAcceptanceCoordinatorShape["pause"] = (caseId, reason, authority) =>
    Effect.gen(function* () {
      const record = yield* load(caseId);
      if (authority === undefined) {
        return yield* acceptanceError("Pause requires authenticated execution authority.", {
          caseId,
          reason: "contradictory-contract",
        });
      }
      yield* requireCompleteAuthority(authority, caseId);
      if (authority.assignmentId !== record.case.assignmentId) {
        return yield* acceptanceError("Pause assignment does not match the durable case.", {
          caseId,
          reason: "contradictory-contract",
        });
      }
      const next = {
        ...record,
        projection: currentProjection(record, "paused", reason),
        case: { ...record.case, updatedAt: now() },
      };
      const saved = yield* save({ record: next, expectedRevision: record.revision });
      return { record: saved, pauseReason: reason };
    });

  const resume: CollaborativeAcceptanceCoordinatorShape["resume"] = (caseId, authority) =>
    Effect.gen(function* () {
      const record = yield* load(caseId);
      if (authority === undefined) {
        return yield* acceptanceError("Resume requires authenticated execution authority.", {
          caseId,
          reason: "contradictory-contract",
        });
      }
      yield* requireCompleteAuthority(authority, caseId);
      if (authority.assignmentId !== record.case.assignmentId) {
        return yield* acceptanceError("Resume assignment does not match the durable case.", {
          caseId,
          reason: "contradictory-contract",
        });
      }
      const next = {
        ...record,
        projection: currentProjection(record, "verifying", null),
        case: { ...record.case, updatedAt: now() },
      };
      const saved = yield* save({ record: next, expectedRevision: record.revision });
      return { record: saved, pauseReason: saved.projection.pauseReason ?? null };
    });

  const decodeAdmissionDelivery = (record: CollaborativeAcceptanceRecord, json: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return Effect.fail(
        acceptanceError("Persisted acceptance delivery is invalid.", {
          caseId: record.case.caseId,
          reason: "ambiguous-outcome",
        }),
      );
    }
    return decodeCollaborationDeliverySchema(parsed).pipe(
      Effect.mapError(() =>
        acceptanceError("Persisted acceptance delivery is unavailable.", {
          caseId: record.case.caseId,
          reason: "ambiguous-outcome",
        }),
      ),
    );
  };

  const dispatchAdmission = (
    record: CollaborativeAcceptanceRecord,
    exchange: CollaborativeAcceptanceExchange,
  ) =>
    Effect.gen(function* () {
      const latest = yield* load(record.case.caseId);
      const latestExchange =
        latest.exchanges.find((item) => item.exchangeId === exchange.exchangeId) ?? exchange;
      const admission = latestExchange.admission;
      if (admission === undefined || latestExchange.requestId === undefined) {
        const attemptId = `dispatch:${hash([latestExchange.exchangeId, "legacy"])}`;
        const next = {
          ...latest,
          exchanges: latest.exchanges.map((item) =>
            item.exchangeId === latestExchange.exchangeId
              ? {
                  ...item,
                  status: "cancelled" as const,
                  cancelledAt: now(),
                  dispatchAttempt: item.dispatchAttempt ?? 1,
                  dispatchAttemptId: item.dispatchAttemptId ?? attemptId,
                  dispatchState: "cancelled" as const,
                  dispatchOutcomeAt: now(),
                  dispatchOutcome: "ambiguous" as const,
                }
              : item,
          ),
          obligations:
            latestExchange.requestId === undefined
              ? latest.obligations
              : resolveObligation(latest, latestExchange.requestId, "unavailable"),
        };
        yield* save({
          record: {
            ...next,
            projection: currentProjection(next, "paused", "ambiguous-outcome"),
            case: { ...next.case, updatedAt: now() },
          },
          expectedRevision: latest.revision,
        });
        return;
      }
      if (
        latestExchange.dispatchState === "succeeded" ||
        latestExchange.status === "completed" ||
        latestExchange.status === "cancelled" ||
        latestExchange.status === "outcome-recorded"
      ) {
        return;
      }
      if (latest.case.currentCandidate.headSha !== exchange.headSha) {
        const cancelled = latest.exchanges.map((item) =>
          item.exchangeId === exchange.exchangeId
            ? {
                ...item,
                status: "cancelled" as const,
                cancelledAt: now(),
                dispatchState: "cancelled" as const,
                dispatchOutcome: "permanent" as const,
                dispatchOutcomeAt: now(),
              }
            : item,
        );
        yield* save({
          record: {
            ...latest,
            exchanges: cancelled,
            projection: currentProjection(
              { ...latest, exchanges: cancelled },
              "paused",
              "stale-head",
            ),
            case: { ...latest.case, updatedAt: now() },
          },
          expectedRevision: latest.revision,
        });
        return;
      }
      const delivery = yield* decodeAdmissionDelivery(latest, admission.deliveryJson);
      const toAuthority = (
        authority: typeof admission.senderAuthority,
        threadId: ThreadId,
      ): CollaborationExecutionAuthority => ({
        executionId: authority.executionId,
        ...(authority.assignmentId === undefined
          ? { assignmentId: latest.case.assignmentId }
          : { assignmentId: authority.assignmentId }),
        threadId,
        generation: authority.generation,
        dispatchId: authority.dispatchId,
        turnId: authority.turnId === null ? null : TurnId.make(authority.turnId),
      });
      const senderAuthority = toAuthority(admission.senderAuthority, admission.senderThreadId);
      const recipientAuthority = toAuthority(
        admission.recipientAuthority,
        admission.recipientThreadId,
      );
      const producingExecution = toAuthority(
        admission.producingExecution,
        admission.senderThreadId,
      );
      if (
        senderAuthority.assignmentId !== latest.case.assignmentId ||
        recipientAuthority.assignmentId !== latest.case.assignmentId ||
        producingExecution.assignmentId !== latest.case.assignmentId
      ) {
        return yield* acceptanceError("Persisted admission authority is not bound to the case.", {
          caseId: latest.case.caseId,
          reason: "contradictory-contract",
        });
      }
      let dispatchReady = latest;
      let dispatchExchange = latestExchange;
      if (dispatchExchange.status === "reserved") {
        const started = startExchange(
          { budget: latest.case.policy.budgets, exchanges: latest.exchanges },
          dispatchExchange.exchangeId,
          now(),
        );
        if (!started.ok) {
          return yield* acceptanceError(`Acceptance admission paused: ${started.error}.`, {
            caseId: latest.case.caseId,
            reason: "budget-exhausted",
          });
        }
        dispatchReady = yield* save({
          record: {
            ...latest,
            exchanges: started.ledger.exchanges,
            projection: currentProjection({ ...latest, exchanges: started.ledger.exchanges }),
            case: { ...latest.case, updatedAt: now() },
          },
          expectedRevision: latest.revision,
        });
        dispatchExchange =
          dispatchReady.exchanges.find((item) => item.exchangeId === dispatchExchange.exchangeId) ??
          dispatchExchange;
      }
      if (dispatchExchange.status !== "committed") {
        return;
      }
      const requestId = latestExchange.requestId;
      const retryingPendingAttempt = latestExchange.dispatchState === "pending";
      const attempt = retryingPendingAttempt
        ? (dispatchExchange.dispatchAttempt ?? 1)
        : (dispatchExchange.dispatchAttempt ?? 0) + 1;
      const attemptId =
        dispatchExchange.dispatchAttemptId ??
        `dispatch:${hash([dispatchExchange.exchangeId, String(attempt)])}`;
      if (attempt > dispatchReady.case.policy.budgets.retries + 1) {
        const exhausted = {
          ...dispatchReady,
          exchanges: dispatchReady.exchanges.map((item) =>
            item.exchangeId === exchange.exchangeId
              ? {
                  ...item,
                  status: "cancelled" as const,
                  cancelledAt: now(),
                  dispatchAttempt: attempt,
                  dispatchAttemptId: attemptId,
                  dispatchState: "cancelled" as const,
                  dispatchOutcomeAt: now(),
                  dispatchOutcome: "unavailable" as const,
                }
              : item,
          ),
        };
        const obligations =
          exchange.requestId === undefined
            ? exhausted.obligations
            : resolveObligation(exhausted, exchange.requestId, "unavailable");
        yield* save({
          record: {
            ...exhausted,
            obligations,
            projection: currentProjection(exhausted, "paused", "retry-limit"),
            case: { ...exhausted.case, updatedAt: now() },
          },
          expectedRevision: dispatchReady.revision,
        });
        return;
      }
      const pending = {
        ...dispatchReady,
        exchanges: dispatchReady.exchanges.map((item) =>
          item.exchangeId === exchange.exchangeId
            ? {
                ...item,
                dispatchAttempt: attempt,
                dispatchAttemptId: attemptId,
                dispatchStartedAt: item.dispatchStartedAt ?? now(),
                dispatchState: "pending" as const,
                retryLineageId: item.retryLineageId ?? exchange.exchangeId,
              }
            : item,
        ),
      };
      const persistedAttempt = yield* save({
        record: {
          ...pending,
          projection: currentProjection(pending),
          case: { ...pending.case, updatedAt: now() },
        },
        expectedRevision: dispatchReady.revision,
      });
      const dispatchResult = yield* engine
        .dispatch({
          type: "thread.collaboration-request.create",
          commandId: commandFor("request", requestId),
          threadId: admission.senderThreadId,
          requestId,
          recipientThreadId: admission.recipientThreadId,
          kind: admission.kind,
          exchangeId: exchange.exchangeId,
          blocking: admission.blocking,
          caseId: exchange.caseId,
          transportContext: { caseId: exchange.caseId, exchangeId: exchange.exchangeId },
          senderAuthority,
          recipientAuthority,
          producingExecution,
          payloadRef: admission.payloadRef,
          candidateRefs: admission.candidateRefs,
          findingRefs: admission.findingRefs.map((finding) =>
            PullRequestMonitorFeedbackRevisionId.make(finding),
          ),
          ...(admission.supersedesRequestId === null
            ? {}
            : { supersedesRequestId: admission.supersedesRequestId }),
          delivery,
          createdAt: admission.createdAt,
        })
        .pipe(Effect.result);
      if (dispatchResult._tag === "Failure") {
        const failure = dispatchResult.failure;
        const permanent =
          isInvariantCommandError(failure) ||
          isPreviouslyRejectedCommandError(failure) ||
          isWorktreeCleanupPendingCommandError(failure);
        const unavailable = permanent && isWorktreeCleanupPendingCommandError(failure);
        const next = {
          ...persistedAttempt,
          exchanges: persistedAttempt.exchanges.map((item) =>
            item.exchangeId === exchange.exchangeId
              ? {
                  ...item,
                  ...(permanent
                    ? {
                        status: "cancelled" as const,
                        cancelledAt: now(),
                        dispatchState: unavailable
                          ? ("cancelled" as const)
                          : ("permanent-failure" as const),
                        dispatchOutcome: unavailable
                          ? ("unavailable" as const)
                          : ("permanent" as const),
                      }
                    : {
                        dispatchState: "ambiguous-failure" as const,
                        dispatchOutcome: "ambiguous" as const,
                      }),
                  dispatchAttempt: attempt,
                  dispatchAttemptId: attemptId,
                  dispatchOutcomeAt: now(),
                }
              : item,
          ),
        };
        const obligations = permanent
          ? exchange.requestId === undefined
            ? next.obligations
            : resolveObligation(next, exchange.requestId, unavailable ? "unavailable" : "failed")
          : next.obligations;
        yield* save({
          record: {
            ...next,
            obligations,
            projection: currentProjection(
              { ...next, obligations },
              "paused",
              permanent
                ? unavailable
                  ? "participant-unavailable"
                  : "provider-failure"
                : "ambiguous-outcome",
            ),
            case: { ...next.case, updatedAt: now() },
          },
          expectedRevision: persistedAttempt.revision,
        });
        return;
      }
      const succeeded = {
        ...persistedAttempt,
        exchanges: persistedAttempt.exchanges.map((item) =>
          item.exchangeId === exchange.exchangeId
            ? {
                ...item,
                dispatchState: "succeeded" as const,
                dispatchOutcomeAt: now(),
              }
            : item,
        ),
      };
      yield* save({
        record: {
          ...succeeded,
          projection: currentProjection(succeeded),
          case: { ...succeeded.case, updatedAt: now() },
        },
        expectedRevision: persistedAttempt.revision,
      });
      yield* wakeThread(admission.recipientThreadId);
    });

  const reconcileExchange = (
    record: CollaborativeAcceptanceRecord,
    exchange: CollaborativeAcceptanceExchange,
    request:
      | {
          readonly status: string;
          readonly terminalOutcome: string | null;
        }
      | undefined,
  ): Effect.Effect<CollaborativeAcceptanceRecord | void, CollaborativeAcceptanceError> =>
    Effect.gen(function* () {
      let next = record;
      if (request === undefined) {
        yield* dispatchAdmission(next, exchange);
        return;
      }
      if (request.status === "response-ready" || request.status === "consumed") {
        const outcome = recordExchangeOutcome(
          { budget: record.case.policy.budgets, exchanges: next.exchanges },
          exchange.exchangeId,
          now(),
        );
        if (outcome.ok && outcome.exchange.status !== exchange.status) {
          next = yield* save({
            record: {
              ...next,
              exchanges: outcome.ledger.exchanges,
              projection: currentProjection({ ...next, exchanges: outcome.ledger.exchanges }),
              case: { ...next.case, updatedAt: now() },
            },
            expectedRevision: next.revision,
          });
        }
        if (request.status === "consumed" && request.terminalOutcome === "completed") {
          const completed = completeExchange(
            { budget: next.case.policy.budgets, exchanges: next.exchanges },
            exchange.exchangeId,
            now(),
          );
          if (completed.ok && completed.exchange.status !== "completed") {
            const obligations =
              exchange.requestId === undefined
                ? next.obligations
                : resolveObligation(next, exchange.requestId, "satisfied");
            next = yield* save({
              record: {
                ...next,
                exchanges: completed.ledger.exchanges,
                ...(obligations === undefined ? {} : { obligations }),
                projection: currentProjection({
                  ...next,
                  exchanges: completed.ledger.exchanges,
                  ...(obligations === undefined ? {} : { obligations }),
                }),
                case: { ...next.case, updatedAt: now() },
              },
              expectedRevision: next.revision,
            });
          }
        } else if (request.status === "consumed") {
          const cancelled = cancelExchange(
            { budget: next.case.policy.budgets, exchanges: next.exchanges },
            exchange.exchangeId,
            now(),
          );
          if (cancelled.ok && exchange.status !== "cancelled") {
            const obligationStatus = obligationStatusForTerminalOutcome(request.terminalOutcome);
            const obligations =
              exchange.requestId === undefined
                ? next.obligations
                : resolveObligation(next, exchange.requestId, obligationStatus);
            next = yield* save({
              record: {
                ...next,
                exchanges: cancelled.ledger.exchanges,
                obligations,
                projection: currentProjection({
                  ...next,
                  exchanges: cancelled.ledger.exchanges,
                  obligations,
                }),
                case: { ...next.case, updatedAt: now() },
              },
              expectedRevision: next.revision,
            });
          }
        }
      } else if (
        request.status === "cancelled" ||
        request.status === "superseded" ||
        request.status === "needs-human" ||
        request.status === "failed" ||
        request.status === "unavailable"
      ) {
        const cancelled = cancelExchange(
          { budget: next.case.policy.budgets, exchanges: next.exchanges },
          exchange.exchangeId,
          now(),
        );
        if (cancelled.ok && exchange.status !== "cancelled") {
          const obligations =
            exchange.requestId === undefined
              ? next.obligations
              : resolveObligation(
                  next,
                  exchange.requestId,
                  request.status === "cancelled"
                    ? "cancelled"
                    : request.status === "superseded"
                      ? "superseded"
                      : request.status === "needs-human"
                        ? "needs-human"
                        : request.status === "unavailable"
                          ? "unavailable"
                          : "failed",
                );
          next = yield* save({
            record: {
              ...next,
              exchanges: cancelled.ledger.exchanges,
              obligations,
              projection: currentProjection({
                ...next,
                exchanges: cancelled.ledger.exchanges,
                obligations,
              }),
              case: { ...next.case, updatedAt: now() },
            },
            expectedRevision: next.revision,
          });
        }
      }
      return next;
    });

  const reconcileExchangeFresh = (
    caseId: CollaborativeAcceptanceCaseId,
    exchangeId: CollaborativeAcceptanceExchange["exchangeId"],
    request:
      | {
          readonly status: string;
          readonly terminalOutcome: string | null;
        }
      | undefined,
  ): Effect.Effect<CollaborativeAcceptanceRecord | void, CollaborativeAcceptanceError> =>
    retryCasConflict(
      load(caseId).pipe(
        Effect.flatMap((record) => {
          const exchange = record.exchanges.find((item) => item.exchangeId === exchangeId);
          return exchange === undefined
            ? Effect.void
            : reconcileExchange(record, exchange, request);
        }),
      ),
    );

  const start: CollaborativeAcceptanceCoordinatorShape["start"] = () =>
    Effect.gen(function* () {
      const firstStart = yield* Ref.modify(started, (value) => [!value, true] as const);
      if (!firstStart) return;
      const subscription = yield* engine.acquireDomainEventSubscription;
      const records = yield* repository
        .listAll()
        .pipe(Effect.mapError(() => acceptanceError("Could not recover acceptance cases.")));
      yield* Effect.forEach(
        records,
        (record) =>
          reconcileSafely(
            record.case.caseId,
            record.case.caseId,
            "collaborative-acceptance.startup-evidence-refresh-failed",
            refreshProviderEvidence(record.case.caseId).pipe(Effect.asVoid),
          ),
        { concurrency: 1, discard: true },
      );
      const readModel = yield* engine.getReadModel();
      yield* Effect.forEach(
        records,
        (record) =>
          Effect.forEach(
            record.exchanges.filter(
              (exchange) =>
                exchange.status === "reserved" ||
                exchange.status === "committed" ||
                exchange.status === "outcome-recorded",
            ),
            (exchange) =>
              reconcileSafely(
                record.case.caseId,
                `${record.case.caseId}:${exchange.exchangeId}`,
                "collaborative-acceptance.startup-exchange-reconciliation-failed",
                reconcileExchangeFresh(
                  record.case.caseId,
                  exchange.exchangeId,
                  readModel.threads
                    .flatMap((thread) =>
                      (thread.collaborationRequests ?? []).map((request) => ({
                        thread,
                        request,
                      })),
                    )
                    .find(({ request }) => request.exchangeId === exchange.exchangeId)?.request,
                ).pipe(Effect.asVoid),
              ),
            { concurrency: 1, discard: true },
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      const reconcileAllActive = Effect.gen(function* () {
        const currentRecords = yield* repository
          .listAll()
          .pipe(Effect.mapError(() => acceptanceError("Could not load acceptance cases.")));
        const currentReadModel = yield* engine.getReadModel();
        yield* Effect.forEach(
          currentRecords,
          (record) =>
            Effect.forEach(
              record.exchanges.filter(
                (exchange) =>
                  exchange.status === "reserved" ||
                  exchange.status === "committed" ||
                  exchange.status === "outcome-recorded",
              ),
              (exchange) => {
                const location = currentReadModel.threads
                  .flatMap((thread) =>
                    (thread.collaborationRequests ?? []).map((request) => ({ thread, request })),
                  )
                  .find(({ request }) => request.exchangeId === exchange.exchangeId);
                return reconcileSafely(
                  record.case.caseId,
                  `${record.case.caseId}:${exchange.exchangeId}`,
                  "collaborative-acceptance.periodic-exchange-reconciliation-failed",
                  reconcileExchangeFresh(
                    record.case.caseId,
                    exchange.exchangeId,
                    location?.request,
                  ).pipe(Effect.asVoid),
                );
              },
              { concurrency: 1, discard: true },
            ),
          { concurrency: 1, discard: true },
        );
      });
      const reconcileEvent = (event: OrchestrationEvent) =>
        Effect.gen(function* () {
          if (event.type === "thread.collaboration-request-updated") {
            const exchangeId = event.payload.request.exchangeId;
            yield* Effect.forEach(
              yield* repository
                .listAll()
                .pipe(Effect.mapError(() => acceptanceError("Could not load acceptance cases."))),
              (record) => {
                const exchange = record.exchanges.find((item) => item.exchangeId === exchangeId);
                return exchange === undefined
                  ? Effect.void
                  : reconcileSafely(
                      record.case.caseId,
                      `${record.case.caseId}:${exchange.exchangeId}`,
                      "collaborative-acceptance.event-reconciliation-failed",
                      reconcileExchangeFresh(
                        record.case.caseId,
                        exchange.exchangeId,
                        event.payload.request,
                      ).pipe(Effect.asVoid),
                    );
              },
              { concurrency: 1, discard: true },
            );
          } else if (
            event.type === "thread.queued-turn-dispatched" ||
            event.type === "thread.queued-turn-failed" ||
            event.type === "thread.queued-turn-deleted"
          ) {
            yield* reconcileAllActive;
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("collaborative-acceptance.live-reconciliation-failed", {
              error,
            }),
          ),
        );
      yield* Effect.forkScoped(
        Stream.forever(Stream.fromEffect(PubSub.take(subscription))).pipe(
          Stream.runForEach(reconcileEvent),
        ),
      );
      yield* Option.match(monitors, {
        onNone: () => Effect.void,
        onSome: (service) =>
          service.subscribeChanges === undefined
            ? Effect.void
            : Effect.forkScoped(
                service.subscribeChanges.pipe(
                  Stream.runForEach(() =>
                    repository.listAll().pipe(
                      Effect.flatMap((currentRecords) =>
                        Effect.forEach(
                          currentRecords,
                          (record) =>
                            reconcileSafely(
                              record.case.caseId,
                              record.case.caseId,
                              "collaborative-acceptance.provider-evidence-refresh-failed",
                              retryCasConflict(
                                refreshProviderEvidence(record.case.caseId).pipe(Effect.asVoid),
                              ),
                            ),
                          { concurrency: 1, discard: true },
                        ),
                      ),
                      Effect.catch((error) =>
                        Effect.logWarning(
                          "collaborative-acceptance.provider-evidence-refresh-failed",
                          {
                            error,
                          },
                        ),
                      ),
                    ),
                  ),
                ),
              ),
      });
      const reconcileDirtyCases = Effect.gen(function* () {
        const dirtyCases = yield* Ref.modify(dirtyReconciliationCases, (cases) => [
          [...cases],
          new Set<CollaborativeAcceptanceCaseId>(),
        ]);
        yield* Effect.forEach(
          dirtyCases,
          (caseId) =>
            reconcileSafely(
              caseId,
              caseId,
              "collaborative-acceptance.dirty-case-reconciliation-failed",
              refreshProviderEvidence(caseId).pipe(Effect.asVoid),
            ),
          { concurrency: 1, discard: true },
        );
      });
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep("1 second").pipe(
            Effect.andThen(
              runReconciliationTick(
                Effect.gen(function* () {
                  const currentRecords = yield* repository
                    .listAll()
                    .pipe(
                      Effect.mapError(() => acceptanceError("Could not load acceptance cases.")),
                    );
                  yield* runReconciliationBatch(
                    currentRecords,
                    (record) =>
                      reconcileSafely(
                        record.case.caseId,
                        record.case.caseId,
                        "collaborative-acceptance.deadline-reconciliation-failed",
                        enforceLimitsFresh(record.case.caseId).pipe(Effect.asVoid),
                      ),
                    () => Effect.void,
                  );
                  yield* reconcileDirtyCases;
                  yield* reconcileAllActive;
                }),
                (error) =>
                  Effect.logWarning("collaborative-acceptance.periodic-reconciliation-failed", {
                    error,
                  }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.onError(() => Ref.set(started, false)));

  return {
    submitCandidate,
    requestReview,
    requestCollaboration,
    respondToRequest,
    dispositionFinding,
    submitAssessment,
    recordProviderEvidence,
    refreshProviderEvidence,
    status,
    pause,
    resume,
    start,
  } satisfies CollaborativeAcceptanceCoordinatorShape;
});

export class CollaborativeAcceptanceCoordinator extends Context.Service<
  CollaborativeAcceptanceCoordinator,
  CollaborativeAcceptanceCoordinatorShape
>()("t3/collaborativeAcceptance/Coordinator") {}

export const CollaborativeAcceptanceCoordinatorLive = Layer.effect(
  CollaborativeAcceptanceCoordinator,
  makeCoordinator,
);
