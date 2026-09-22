import {
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceError,
  PullRequestMonitorReviewCandidate,
  type CollaborativeAcceptanceAssessment,
  type CollaborativeAcceptanceCandidate,
  type CollaborativeAcceptanceCandidateSubmission,
  type CollaborativeAcceptancePauseReason,
  type CollaborativeAcceptanceProvenance,
  type CollaborativeAcceptanceRecord,
  type CollaborationExecutionAuthority,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CollaborativeAcceptanceRepository } from "../persistence/Services/CollaborativeAcceptance.ts";
import { advanceAcceptanceCandidate, evaluateAcceptance } from "./domain.ts";
import { isCompleteAcceptanceAuthority } from "./authority.ts";

type Repository = CollaborativeAcceptanceRepository["Service"];
const decodeReviewCandidate = Schema.decodeUnknownEffect(PullRequestMonitorReviewCandidate);

export type AcceptanceCaseMutationCommand =
  | {
      readonly _tag: "submit-candidate";
      readonly caseId: CollaborativeAcceptanceCaseId;
      readonly submission: CollaborativeAcceptanceCandidateSubmission;
      readonly recipientThreadId: ThreadId;
      readonly senderAuthority: CollaborationExecutionAuthority;
    }
  | {
      readonly _tag: "submit-assessment";
      readonly caseId: CollaborativeAcceptanceCaseId;
      readonly assessment: CollaborativeAcceptanceAssessment;
      readonly authority: CollaborationExecutionAuthority | undefined;
    }
  | {
      readonly _tag: "record-provider-evidence";
      readonly caseId: CollaborativeAcceptanceCaseId;
      readonly evidence: NonNullable<CollaborativeAcceptanceRecord["providerEvidence"]>;
    }
  | {
      readonly _tag: "invalidate-provider-evidence";
      readonly caseId: CollaborativeAcceptanceCaseId;
      readonly reason: CollaborativeAcceptancePauseReason;
    }
  | {
      readonly _tag: "pause";
      readonly caseId: CollaborativeAcceptanceCaseId;
      readonly reason: CollaborativeAcceptancePauseReason;
      readonly authority: CollaborationExecutionAuthority | undefined;
    }
  | {
      readonly _tag: "resume";
      readonly caseId: CollaborativeAcceptanceCaseId;
      readonly authority: CollaborationExecutionAuthority | undefined;
    }
  | {
      readonly _tag: "enforce-limits";
      readonly caseId: CollaborativeAcceptanceCaseId;
    };

export interface AcceptanceCaseMutation {
  readonly load: (
    caseId: CollaborativeAcceptanceCaseId,
  ) => Effect.Effect<CollaborativeAcceptanceRecord, CollaborativeAcceptanceError>;
  readonly persist: (
    record: CollaborativeAcceptanceRecord,
    options?: {
      readonly executionPhase?: CollaborativeAcceptanceRecord["projection"]["executionPhase"];
      readonly pauseReason?: CollaborativeAcceptancePauseReason | null;
    },
  ) => Effect.Effect<CollaborativeAcceptanceRecord, CollaborativeAcceptanceError>;
  readonly execute: (
    command: AcceptanceCaseMutationCommand,
  ) => Effect.Effect<CollaborativeAcceptanceRecord, CollaborativeAcceptanceError>;
}

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

const requireAuthority = (
  authority: CollaborationExecutionAuthority | undefined,
  input: {
    readonly caseId: CollaborativeAcceptanceCaseId;
    readonly assignmentId?: string;
    readonly missingMessage: string;
    readonly mismatchMessage: string;
  },
) => {
  if (authority === undefined || !isCompleteAcceptanceAuthority(authority)) {
    return Effect.fail(
      acceptanceError(input.missingMessage, {
        caseId: input.caseId,
        reason: "contradictory-contract",
      }),
    );
  }
  if (input.assignmentId !== undefined && authority.assignmentId !== input.assignmentId) {
    return Effect.fail(
      acceptanceError(input.mismatchMessage, {
        caseId: input.caseId,
        reason: "contradictory-contract",
      }),
    );
  }
  return Effect.succeed(authority);
};

const candidateProvenance = (input: {
  readonly caseId: CollaborativeAcceptanceCaseId;
  readonly submission: CollaborativeAcceptanceCandidateSubmission;
  readonly authority: CollaborationExecutionAuthority;
}): CollaborativeAcceptanceProvenance => ({
  assignmentId: input.submission.assignmentId,
  dispatchId: input.authority.dispatchId,
  turnId: input.authority.turnId,
  generation: input.authority.generation,
  caseId: input.caseId,
  candidateId: input.submission.candidate.candidateId,
  headSha: input.submission.candidate.headSha,
  contractRevision: input.submission.candidate.contractRevision,
  reviewWorkflow: input.submission.candidate.reviewWorkflow,
});

const candidateMatchesSubmission = (
  caseId: CollaborativeAcceptanceCaseId,
  candidate: CollaborativeAcceptanceCandidate,
  submission: CollaborativeAcceptanceCandidateSubmission,
): boolean => {
  const reviewCandidate = submission.reviewCandidate;
  return (
    reviewCandidate.caseId === caseId &&
    reviewCandidate.candidateId === candidate.candidateId &&
    reviewCandidate.reviewEpoch === candidate.reviewEpoch &&
    reviewCandidate.headSha === candidate.headSha &&
    reviewCandidate.contractRevision === candidate.contractRevision &&
    reviewCandidate.reviewWorkflow.identity === candidate.reviewWorkflow.identity &&
    reviewCandidate.reviewWorkflow.version === candidate.reviewWorkflow.version
  );
};

const contractMatchesSubmission = (
  record: CollaborativeAcceptanceRecord,
  submission: CollaborativeAcceptanceCandidateSubmission,
  candidate: CollaborativeAcceptanceCandidate,
): boolean =>
  record.case.assignmentId === submission.assignmentId &&
  record.case.pullRequest.repository === submission.pullRequest.repository &&
  record.case.pullRequest.number === submission.pullRequest.number &&
  record.case.contractRevision === candidate.contractRevision &&
  record.case.policy.reviewWorkflow.identity === candidate.reviewWorkflow.identity &&
  record.case.policy.reviewWorkflow.version === candidate.reviewWorkflow.version &&
  record.case.policy.commentPolicy === submission.policy.commentPolicy &&
  record.case.policy.reviewTrigger === submission.policy.reviewTrigger &&
  record.case.policy.automation === submission.policy.automation &&
  JSON.stringify(record.case.policy.budgets) === JSON.stringify(submission.policy.budgets);

const validateReviewCandidate = (
  candidate: CollaborativeAcceptanceCandidate,
  caseId: CollaborativeAcceptanceCaseId,
) =>
  decodeReviewCandidate(candidate.reviewCandidate).pipe(
    Effect.mapError(() =>
      acceptanceError("Candidate review metadata is unavailable or invalid.", {
        caseId,
        reason: "contradictory-contract",
      }),
    ),
  );

export const makeAcceptanceCaseMutation = (
  repository: Repository,
  clock: () => string = () => new Date().toISOString(),
): AcceptanceCaseMutation => {
  const load: AcceptanceCaseMutation["load"] = (caseId) =>
    repository.getByCaseId({ caseId }).pipe(
      Effect.mapError(() => acceptanceError("Could not load the acceptance case.", { caseId })),
      Effect.flatMap((record) =>
        Option.isSome(record)
          ? Effect.succeed(record.value)
          : Effect.fail(acceptanceError("Acceptance case not found.", { caseId })),
      ),
    );

  const project = (
    record: CollaborativeAcceptanceRecord,
    executionPhase: CollaborativeAcceptanceRecord["projection"]["executionPhase"] = "verifying",
    pauseReason?: CollaborativeAcceptancePauseReason | null,
  ): CollaborativeAcceptanceRecord => {
    const updatedAt = clock();
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
      updatedAt,
    });
    const activeExchange = record.exchanges.find(
      (exchange) => exchange.status === "reserved" || exchange.status === "committed",
    );
    return {
      ...record,
      case: { ...record.case, updatedAt },
      projection: {
        ...evaluation.projection,
        ...(effectivePauseReason === undefined || effectivePauseReason === null
          ? {}
          : { pauseReason: effectivePauseReason }),
        ...(activeExchange === undefined ? {} : { activeExchangeId: activeExchange.exchangeId }),
      },
    };
  };

  const save = (
    record: CollaborativeAcceptanceRecord,
    input: {
      readonly expectedRevision: number | null;
      readonly executionPhase?: CollaborativeAcceptanceRecord["projection"]["executionPhase"];
      readonly pauseReason?: CollaborativeAcceptancePauseReason | null;
    },
  ) =>
    repository
      .save({
        record: project(record, input.executionPhase, input.pauseReason),
        expectedRevision: input.expectedRevision,
      })
      .pipe(
        Effect.mapError(() =>
          acceptanceError("Acceptance case changed concurrently; retry.", {
            caseId: record.case.caseId,
          }),
        ),
      );

  const persist: AcceptanceCaseMutation["persist"] = (record, options = {}) =>
    save(record, {
      expectedRevision: record.revision,
      ...options,
    });

  const submitCandidate = (
    command: Extract<AcceptanceCaseMutationCommand, { readonly _tag: "submit-candidate" }>,
  ) =>
    Effect.gen(function* () {
      const authority = yield* requireAuthority(command.senderAuthority, {
        caseId: command.caseId,
        assignmentId: command.submission.assignmentId,
        missingMessage:
          "Acceptance mutations require a complete authenticated execution authority.",
        mismatchMessage: "Candidate provenance does not match authenticated execution.",
      });
      const provenance = candidateProvenance({
        caseId: command.caseId,
        submission: command.submission,
        authority,
      });
      if (
        command.submission.candidate.provenance !== undefined &&
        JSON.stringify(command.submission.candidate.provenance) !== JSON.stringify(provenance)
      ) {
        return yield* acceptanceError(
          "Candidate provenance does not match authenticated execution.",
          {
            caseId: command.caseId,
            reason: "contradictory-contract",
          },
        );
      }
      const candidate = {
        ...command.submission.candidate,
        reviewCandidate: command.submission.reviewCandidate,
        provenance,
      };
      if (!candidateMatchesSubmission(command.caseId, candidate, command.submission)) {
        return yield* acceptanceError(
          "Review-candidate provenance does not match the submitted candidate.",
          {
            caseId: command.caseId,
            reason: "contradictory-contract",
          },
        );
      }
      if (
        command.submission.initialEvidence.length === 0 ||
        command.submission.initialEvidence.some(
          (evidence) =>
            evidence.caseId !== command.caseId ||
            evidence.candidateId !== candidate.candidateId ||
            evidence.headSha !== candidate.headSha ||
            !evidence.current ||
            !evidence.complete,
        )
      ) {
        return yield* acceptanceError(
          command.submission.initialEvidence.length === 0
            ? "A candidate requires initial evidence."
            : "Initial evidence must be complete, current, and bound to the submitted case, candidate, and head.",
          { caseId: command.caseId, reason: "contradictory-contract" },
        );
      }

      const existing = yield* repository
        .getByCaseId({ caseId: command.caseId })
        .pipe(
          Effect.mapError(() =>
            acceptanceError("Could not load the acceptance case.", { caseId: command.caseId }),
          ),
        );
      if (Option.isNone(existing)) {
        yield* validateReviewCandidate(candidate, command.caseId);
        const acceptanceCase = {
          caseId: command.caseId,
          assignmentId: command.submission.assignmentId,
          parentThreadId: command.recipientThreadId,
          pullRequest: command.submission.pullRequest,
          contractRevision: candidate.contractRevision,
          currentCandidate: candidate,
          criteria: command.submission.criteria,
          policy: command.submission.policy,
          createdAt: candidate.createdAt,
          updatedAt: candidate.createdAt,
        };
        return yield* save(
          {
            revision: 0,
            case: acceptanceCase,
            candidates: [candidate],
            evidence: command.submission.initialEvidence,
            assessments: [],
            exchanges: [],
            projection: {
              caseId: command.caseId,
              candidateId: candidate.candidateId,
              headSha: candidate.headSha,
              executionPhase: "verifying",
              collaborationStatus: "child-assessment-pending",
              acceptanceLifecycle: "pending",
              readiness: "no-known-blockers",
              reasons: [],
              staleAssessmentIds: [],
              updatedAt: candidate.createdAt,
            },
          },
          { expectedRevision: null },
        );
      }

      const record = existing.value;
      yield* validateReviewCandidate(candidate, command.caseId);
      yield* validateReviewCandidate(record.case.currentCandidate, command.caseId);
      if (!contractMatchesSubmission(record, command.submission, candidate)) {
        return yield* acceptanceError(
          "Candidate provenance does not match the durable acceptance contract.",
          {
            caseId: command.caseId,
            reason: "contradictory-contract",
          },
        );
      }
      const existingCandidate = record.candidates.find(
        (entry) => entry.candidateId === candidate.candidateId,
      );
      if (existingCandidate !== undefined) {
        if (
          existingCandidate.reviewEpoch === candidate.reviewEpoch &&
          existingCandidate.headSha === candidate.headSha &&
          existingCandidate.contractRevision === candidate.contractRevision &&
          existingCandidate.reviewWorkflow.identity === candidate.reviewWorkflow.identity &&
          existingCandidate.reviewWorkflow.version === candidate.reviewWorkflow.version &&
          JSON.stringify(existingCandidate.reviewCandidate) ===
            JSON.stringify(candidate.reviewCandidate)
        ) {
          return record;
        }
        return yield* acceptanceError(
          "Candidate identity is already bound to different immutable provenance.",
          {
            caseId: command.caseId,
            reason: "contradictory-contract",
          },
        );
      }
      const transition = advanceAcceptanceCandidate(record.case, candidate);
      if (!transition.ok) {
        return yield* acceptanceError("Candidate review epoch must increase.", {
          caseId: command.caseId,
          reason: "contradictory-contract",
        });
      }
      return yield* save(
        {
          ...record,
          case: transition.acceptanceCase,
          candidates: record.candidates.some((entry) => entry.candidateId === candidate.candidateId)
            ? record.candidates
            : [...record.candidates, candidate],
          evidence: [...record.evidence, ...command.submission.initialEvidence],
        },
        { expectedRevision: record.revision },
      );
    });

  const execute: AcceptanceCaseMutation["execute"] = (command) => {
    switch (command._tag) {
      case "submit-candidate":
        return submitCandidate(command);
      case "submit-assessment":
        return Effect.gen(function* () {
          const record = yield* load(command.caseId);
          yield* requireAuthority(command.authority, {
            caseId: command.caseId,
            assignmentId: record.case.assignmentId,
            missingMessage: "Assessment requires authenticated execution authority.",
            mismatchMessage: "Assessment assignment does not match the durable case.",
          });
          const candidate = record.case.currentCandidate;
          const assessment = command.assessment;
          if (
            assessment.caseId !== command.caseId ||
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
                caseId: command.caseId,
                reason: "contradictory-contract",
              },
            );
          }
          return yield* save(
            {
              ...record,
              assessments: record.assessments.some(
                (item) => item.assessmentId === assessment.assessmentId,
              )
                ? record.assessments
                : [...record.assessments, assessment],
            },
            { expectedRevision: record.revision },
          );
        });
      case "record-provider-evidence":
        return Effect.gen(function* () {
          const record = yield* load(command.caseId);
          if (
            command.evidence.caseId === undefined ||
            command.evidence.sourceId === undefined ||
            command.evidence.caseId !== command.caseId ||
            command.evidence.candidateId !== record.case.currentCandidate.candidateId ||
            command.evidence.headSha !== record.case.currentCandidate.headSha
          ) {
            yield* save(
              { ...record, providerEvidence: null },
              {
                expectedRevision: record.revision,
                executionPhase: "paused",
                pauseReason: "stale-head",
              },
            );
            return yield* acceptanceError("Provider evidence is stale for the current candidate.", {
              caseId: command.caseId,
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
            existing.sourceRevision === command.evidence.sourceRevision &&
            comparable(existing) === comparable(command.evidence)
          ) {
            return record;
          }
          return yield* save(
            { ...record, providerEvidence: command.evidence },
            {
              expectedRevision: record.revision,
              executionPhase:
                command.evidence.pullRequestState === "open" ? "monitoring" : "paused",
              ...(command.evidence.pullRequestState === "open"
                ? {}
                : { pauseReason: "closed-pull-request" }),
            },
          );
        });
      case "invalidate-provider-evidence":
        return load(command.caseId).pipe(
          Effect.flatMap((record) =>
            save(
              { ...record, providerEvidence: null },
              {
                expectedRevision: record.revision,
                executionPhase: "paused",
                pauseReason: command.reason,
              },
            ),
          ),
        );
      case "pause":
        return Effect.gen(function* () {
          const record = yield* load(command.caseId);
          yield* requireAuthority(command.authority, {
            caseId: command.caseId,
            assignmentId: record.case.assignmentId,
            missingMessage: "Pause requires authenticated execution authority.",
            mismatchMessage: "Pause assignment does not match the durable case.",
          });
          return yield* save(record, {
            expectedRevision: record.revision,
            executionPhase: "paused",
            pauseReason: command.reason,
          });
        });
      case "resume":
        return Effect.gen(function* () {
          const record = yield* load(command.caseId);
          yield* requireAuthority(command.authority, {
            caseId: command.caseId,
            assignmentId: record.case.assignmentId,
            missingMessage: "Resume requires authenticated execution authority.",
            mismatchMessage: "Resume assignment does not match the durable case.",
          });
          return yield* save(record, {
            expectedRevision: record.revision,
            executionPhase: "verifying",
            pauseReason: null,
          });
        });
      case "enforce-limits":
        return Effect.gen(function* () {
          const record = yield* load(command.caseId);
          const active = record.exchanges.find(
            (exchange) => exchange.status === "reserved" || exchange.status === "committed",
          );
          const now = Date.parse(clock());
          const budgets = record.case.policy.budgets;
          const disputedAssessments = record.assessments.filter(
            (assessment) =>
              assessment.role === "parent-reviewer" &&
              assessment.outcome !== "pass" &&
              assessment.outcome !== "acknowledged",
          ).length;
          let reason: CollaborativeAcceptancePauseReason | undefined;
          if (
            active?.status === "committed" &&
            active.startedAt !== null &&
            budgets.executionDurationSeconds > 0 &&
            now - Date.parse(active.startedAt) >= budgets.executionDurationSeconds * 1000
          ) {
            reason = "duration-limit";
          } else if (
            active !== undefined &&
            budgets.waitingDeadlineSeconds > 0 &&
            now - Date.parse(active.startedAt ?? active.reservedAt) >=
              budgets.waitingDeadlineSeconds * 1000
          ) {
            reason = "waiting-deadline";
          } else if (disputedAssessments > 0 && disputedAssessments >= budgets.disputeRounds) {
            reason = "dispute-limit";
          }
          if (reason === undefined || record.projection.pauseReason === reason) {
            return record;
          }
          return yield* save(record, {
            expectedRevision: record.revision,
            executionPhase: "paused",
            pauseReason: reason,
          });
        });
    }
  };

  return { load, persist, execute };
};
