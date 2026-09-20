import {
  CollaborativeAcceptanceCandidateId,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceError,
  CollaborativeAcceptanceExecutionId,
  CollaborativeAcceptanceExchangeId,
  CollaborativeAcceptanceProvenance,
  CollaborativeAcceptanceStatus,
  CollaborationRequestId,
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
  type PullRequestMonitorFeedbackReportDisposition,
  type PullRequestMonitorReviewCandidate,
  type PullRequestRef,
  type ThreadId,
  QueuedTurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Crypto from "node:crypto";

import {
  advanceAcceptanceCandidate,
  evaluateAcceptance,
  reserveExchange,
  startExchange,
} from "./domain.ts";
import { CollaborativeAcceptanceRepository } from "../persistence/Services/CollaborativeAcceptance.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { QueuedTurnReactor } from "../orchestration/Services/QueuedTurnReactor.ts";
import { PullRequestMonitorService } from "../pullRequestMonitor/PullRequestMonitorService.ts";
import {
  reviewCandidateEligibility,
  type ReviewCandidateMode,
} from "../pullRequestMonitor/reviewCandidate.ts";

const hash = (parts: ReadonlyArray<string>) =>
  Crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);

const now = () => new Date().toISOString();

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
    readonly itemId: string;
    readonly disposition: PullRequestMonitorFeedbackReportDisposition;
    readonly note?: string;
    readonly reporterThreadId: ThreadId;
  }) => Effect.Effect<unknown, CollaborativeAcceptanceError>;
  readonly submitAssessment: (input: {
    readonly caseId: CollaborativeAcceptanceCaseId;
    readonly assessment: CollaborativeAcceptanceAssessment;
  }) => Effect.Effect<CollaborativeAcceptanceStatus, CollaborativeAcceptanceError>;
  readonly recordProviderEvidence: (input: {
    readonly caseId: CollaborativeAcceptanceCaseId;
    readonly evidence: NonNullable<CollaborativeAcceptanceRecord["providerEvidence"]>;
  }) => Effect.Effect<CollaborativeAcceptanceStatus, CollaborativeAcceptanceError>;
  readonly status: (
    caseId: CollaborativeAcceptanceCaseId,
  ) => Effect.Effect<CollaborativeAcceptanceStatus, CollaborativeAcceptanceError>;
  readonly pause: (
    caseId: CollaborativeAcceptanceCaseId,
    reason: CollaborativeAcceptancePauseReason,
  ) => Effect.Effect<CollaborativeAcceptanceStatus, CollaborativeAcceptanceError>;
  readonly resume: (
    caseId: CollaborativeAcceptanceCaseId,
  ) => Effect.Effect<CollaborativeAcceptanceStatus, CollaborativeAcceptanceError>;
  readonly start: () => Effect.Effect<void, never, import("effect/Scope").Scope>;
}

const makeCoordinator = Effect.gen(function* () {
  const repository = yield* CollaborativeAcceptanceRepository;
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const queuedTurns = yield* Effect.serviceOption(QueuedTurnReactor);
  const monitors = yield* Effect.serviceOption(PullRequestMonitorService);

  const load = (caseId: CollaborativeAcceptanceCaseId) =>
    repository.getByCaseId({ caseId }).pipe(
      Effect.mapError(() => acceptanceError("Could not load the acceptance case.", { caseId })),
      Effect.flatMap((record) =>
        Option.isSome(record)
          ? Effect.succeed(record.value)
          : Effect.fail(acceptanceError("Acceptance case not found.", { caseId })),
      ),
    );

  const save = (record: CollaborativeAcceptanceRecord) =>
    repository
      .save({ record, expectedRevision: record.revision })
      .pipe(Effect.mapError(() => acceptanceError("Acceptance case changed concurrently; retry.")));

  const currentProjection = (
    record: CollaborativeAcceptanceRecord,
    executionPhase: CollaborativeAcceptanceRecord["projection"]["executionPhase"] = "verifying",
    pauseReason?: CollaborativeAcceptancePauseReason,
  ) => {
    const evaluation = evaluateAcceptance({
      case: record.case,
      candidate: record.case.currentCandidate,
      executionPhase,
      providerEvidence: record.providerEvidence ?? null,
      evidence: record.evidence,
      assessments: record.assessments,
      collaborationObligations: [],
      updatedAt: now(),
    });
    return {
      ...evaluation.projection,
      ...(pauseReason === undefined ? {} : { pauseReason }),
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

  const wakeThread = (threadId: ThreadId): Effect.Effect<void, never> =>
    Option.match(queuedTurns, {
      onNone: () => Effect.void,
      onSome: (reactor) =>
        reactor.wakeThread === undefined ? Effect.void : reactor.wakeThread(threadId),
    });

  const status = (caseId: CollaborativeAcceptanceCaseId) =>
    load(caseId).pipe(
      Effect.map((record) => ({
        record,
        pauseReason: record.projection.pauseReason ?? null,
      })),
    );

  const persistCandidate = (input: {
    readonly submission: CollaborativeAcceptanceCandidateSubmission;
    readonly senderThreadId: ThreadId;
    readonly recipientThreadId: ThreadId;
  }) =>
    Effect.gen(function* () {
      const caseId =
        input.submission.caseId ??
        CollaborativeAcceptanceCaseId.make(`acceptance:${input.submission.assignmentId}`);
      const candidate = {
        ...input.submission.candidate,
        reviewCandidate: input.submission.reviewCandidate,
        provenance:
          input.submission.candidate.provenance ??
          ({
            assignmentId: input.submission.assignmentId,
            dispatchId: null,
            turnId: null,
            caseId,
            candidateId: input.submission.candidate.candidateId,
            headSha: input.submission.candidate.headSha,
            contractRevision: input.submission.candidate.contractRevision,
            reviewWorkflow: input.submission.candidate.reviewWorkflow,
          } satisfies CollaborativeAcceptanceProvenance),
      };
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
            projection: {} as CollaborativeAcceptanceRecord["projection"],
          }),
        };
        return yield* Effect.succeed(record);
      }

      const record = existing.value;
      const transition = advanceAcceptanceCandidate(record.case, candidate);
      if (!transition.ok) {
        return yield* acceptanceError("Candidate review epoch must increase.", {
          caseId,
          reason: "contradictory-contract",
        });
      }
      return {
        ...record,
        case: transition.acceptanceCase,
        candidates: record.candidates.some((entry) => entry.candidateId === candidate.candidateId)
          ? record.candidates
          : [...record.candidates, candidate],
        evidence: [...record.evidence, ...input.submission.initialEvidence],
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
      const exchangeId = exchangeFor(caseId, input.candidate.candidateId, input.mode);
      const requestId = requestFor(exchangeId);
      const equivalent = input.record.exchanges.find(
        (exchange) => exchange.exchangeId === exchangeId && exchange.status !== "cancelled",
      );
      if (equivalent !== undefined) return input.record;

      if (
        !input.force &&
        (input.record.case.policy.automation === "off" ||
          input.record.case.policy.reviewTrigger === "manual")
      ) {
        return input.record;
      }

      if (
        !reviewCandidateEligibility({
          candidate: input.reviewCandidate,
          previous: (() => {
            const previous = input.record.candidates.at(-2)?.reviewCandidate;
            return previous === undefined ? null : (previous as PullRequestMonitorReviewCandidate);
          })(),
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
      };
      const reserved = reserveExchange(
        { budget: input.record.case.policy.budgets, exchanges: input.record.exchanges },
        exchange,
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
      const started = startExchange(reserved.ledger, exchangeId, now());
      if (!started.ok) {
        return yield* acceptanceError(`Review admission paused: ${started.error}.`, {
          caseId,
          reason: "budget-exhausted",
        });
      }

      const latestHead = input.candidate.headSha;
      if (input.record.case.currentCandidate.headSha !== latestHead) {
        return yield* acceptanceError("Candidate changed before review dispatch.", {
          caseId,
          reason: "stale-head",
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
      yield* engine
        .dispatch({
          type: "thread.collaboration-request.create",
          commandId: commandFor("request", requestId),
          threadId: input.senderThreadId,
          requestId,
          recipientThreadId: input.authority.recipientThreadId,
          kind: "review",
          exchangeId,
          blocking: true,
          caseId,
          transportContext: { caseId, exchangeId },
          senderAuthority: input.authority.senderAuthority,
          recipientAuthority: input.authority.recipientAuthority,
          producingExecution: input.authority.senderAuthority,
          payloadRef,
          candidateRefs: [input.candidate.candidateId],
          findingRefs: [],
          ...(previousRequest === undefined
            ? {}
            : { supersedesRequestId: previousRequest.requestId }),
          delivery: {
            queuedTurnId: queuedTurnFor(requestId),
            message: {
              messageId: messageFor(requestId),
              role: "user",
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
          },
          createdAt: now(),
        })
        .pipe(
          Effect.mapError(() =>
            acceptanceError("Review request could not be admitted.", { caseId }),
          ),
        );

      const committedExchanges = started.ledger.exchanges.map((item) =>
        item.exchangeId === exchangeId ? { ...started.exchange, requestId } : item,
      );
      const committedRecord = {
        ...input.record,
        exchanges: committedExchanges,
        projection: currentProjection({
          ...input.record,
          exchanges: committedExchanges,
        }),
        case: { ...input.record.case, updatedAt: now() },
      };
      yield* save(committedRecord);
      yield* wakeThread(input.authority.recipientThreadId);
      return committedRecord;
    });

  const submitCandidate: CollaborativeAcceptanceCoordinatorShape["submitCandidate"] = (input) =>
    Effect.gen(function* () {
      const record = yield* persistCandidate({
        submission: input,
        senderThreadId: input.senderThreadId,
        recipientThreadId: input.recipientThreadId,
      });
      const candidate = record.case.currentCandidate;
      const reviewCandidate = candidate.reviewCandidate as PullRequestMonitorReviewCandidate;
      const previous = record.candidates.at(-2)?.reviewCandidate as
        | PullRequestMonitorReviewCandidate
        | undefined;
      const eligibility = reviewCandidateEligibility({
        candidate: reviewCandidate,
        ...(previous === undefined ? {} : { previous }),
      });
      const shouldTrigger =
        input.candidate.reviewEpoch === 1
          ? input.policy.reviewTrigger === "first-candidate" ||
            input.policy.reviewTrigger === "each-eligible-candidate"
          : input.policy.reviewTrigger === "each-eligible-candidate";
      const persisted = yield* save({
        ...record,
        projection: currentProjection(record),
        case: { ...record.case, updatedAt: now() },
      });
      if (!shouldTrigger || !eligibility.eligible || input.policy.automation === "off") {
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
      const record = yield* load(input.caseId);
      const reviewCandidate = record.case.currentCandidate
        .reviewCandidate as PullRequestMonitorReviewCandidate;
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
      const exchangeId = CollaborativeAcceptanceExchangeId.make(
        `exchange:${hash([input.assignmentId, input.senderThreadId, input.recipientThreadId, input.kind, input.text])}`,
      );
      const requestId = requestFor(exchangeId);
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
      yield* engine
        .dispatch({
          type: "thread.collaboration-request.create",
          commandId: commandFor("request", requestId),
          threadId: input.senderThreadId,
          requestId,
          recipientThreadId: input.recipientThreadId,
          kind: input.kind,
          exchangeId,
          blocking: true,
          ...(caseId === undefined ? {} : { caseId, transportContext: { caseId, exchangeId } }),
          senderAuthority: input.senderAuthority,
          recipientAuthority: input.recipientAuthority,
          producingExecution: input.senderAuthority,
          payloadRef: {
            ref: `collaboration://${requestId}`,
            sha256: Crypto.createHash("sha256").update(input.text).digest("hex"),
          },
          candidateRefs: [],
          findingRefs: [],
          delivery: {
            queuedTurnId: queuedTurnFor(requestId),
            message: {
              messageId: messageFor(requestId),
              role: "user",
              text: input.text,
              attachments: [],
            },
            modelSelection: recipient.modelSelection,
            runtimeMode: recipient.runtimeMode,
            interactionMode: recipient.interactionMode,
          },
          createdAt: now(),
        })
        .pipe(Effect.mapError(() => acceptanceError("Collaboration request could not be queued.")));
      yield* wakeThread(input.recipientThreadId);
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
          responseId:
            `response:${hash([input.requestId, input.responseAuthority.executionId, input.text])}` as never,
          exchangeId: location.request.exchangeId,
          responderAuthority: input.responseAuthority,
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
      yield* wakeThread(location.request.senderThreadId);
    });

  const submitAssessment: CollaborativeAcceptanceCoordinatorShape["submitAssessment"] = (input) =>
    Effect.gen(function* () {
      const record = yield* load(input.caseId);
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
        ...next,
        projection: currentProjection(next),
        case: { ...next.case, updatedAt: now() },
      });
      return { record: saved, pauseReason: saved.projection.pauseReason ?? null };
    });

  const recordProviderEvidence: CollaborativeAcceptanceCoordinatorShape["recordProviderEvidence"] =
    (input) =>
      Effect.gen(function* () {
        const record = yield* load(input.caseId);
        if (
          input.evidence.candidateId !== record.case.currentCandidate.candidateId ||
          input.evidence.headSha !== record.case.currentCandidate.headSha
        ) {
          return yield* acceptanceError("Provider evidence is stale for the current candidate.", {
            caseId: input.caseId,
            reason: "stale-head",
          });
        }
        const next = { ...record, providerEvidence: input.evidence };
        const saved = yield* save({
          ...next,
          projection: currentProjection(next),
          case: { ...next.case, updatedAt: now() },
        });
        return { record: saved, pauseReason: saved.projection.pauseReason ?? null };
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
            itemId: input.itemId as never,
            disposition: input.disposition,
            ...(input.note === undefined ? {} : { note: input.note }),
            reporterThreadId: input.reporterThreadId,
          })
          .pipe(
            Effect.mapError(() => acceptanceError("Finding disposition could not be recorded.")),
          ),
    });

  const pause: CollaborativeAcceptanceCoordinatorShape["pause"] = (caseId, reason) =>
    Effect.gen(function* () {
      const record = yield* load(caseId);
      const next = {
        ...record,
        projection: currentProjection(record, "paused", reason),
        case: { ...record.case, updatedAt: now() },
      };
      const saved = yield* save(next);
      return { record: saved, pauseReason: reason };
    });

  const resume: CollaborativeAcceptanceCoordinatorShape["resume"] = (caseId) =>
    Effect.gen(function* () {
      const record = yield* load(caseId);
      const next = {
        ...record,
        projection: currentProjection(record, "verifying"),
        case: { ...record.case, updatedAt: now() },
      };
      const saved = yield* save(next);
      return { record: saved, pauseReason: saved.projection.pauseReason ?? null };
    });

  const start: CollaborativeAcceptanceCoordinatorShape["start"] = () =>
    Effect.gen(function* () {
      const records = yield* repository
        .listAll()
        .pipe(Effect.mapError(() => acceptanceError("Could not recover acceptance cases.")));
      yield* Effect.forEach(
        records,
        (record) =>
          Effect.forEach(
            record.exchanges.filter(
              (exchange) =>
                (exchange.status === "reserved" || exchange.status === "committed") &&
                exchange.requestId === undefined,
            ),
            () =>
              Effect.logWarning("acceptance exchange requires recovery", {
                caseId: record.case.caseId,
              }),
            { concurrency: 1 },
          ),
        { concurrency: 1 },
      );
    }).pipe(
      Effect.catch((error) => Effect.logError("Collaborative acceptance recovery failed.", error)),
    );

  return {
    submitCandidate,
    requestReview,
    requestCollaboration,
    respondToRequest,
    dispositionFinding,
    submitAssessment,
    recordProviderEvidence,
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
