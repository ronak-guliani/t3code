import type {
  CollaborativeAcceptanceAssessment,
  CollaborativeAcceptanceAssessmentRole,
  CollaborativeAcceptanceBudgets,
  CollaborativeAcceptanceCandidate,
  CollaborativeAcceptanceCase,
  CollaborativeAcceptanceEvidence,
  CollaborativeAcceptanceExchange,
  CollaborativeAcceptanceExchangeStatus,
  CollaborativeAcceptanceExecutionPhase,
  CollaborativeAcceptanceProviderEvidence,
  CollaborativeAcceptanceProjection,
} from "@t3tools/contracts";

export type AcceptanceExecutionPhase = CollaborativeAcceptanceExecutionPhase;

export interface AcceptanceEvaluationInput {
  readonly case: CollaborativeAcceptanceCase;
  readonly candidate: CollaborativeAcceptanceCandidate;
  readonly executionPhase: AcceptanceExecutionPhase;
  readonly providerEvidence: CollaborativeAcceptanceProviderEvidence | null;
  readonly evidence: ReadonlyArray<CollaborativeAcceptanceEvidence>;
  readonly assessments: ReadonlyArray<CollaborativeAcceptanceAssessment>;
  readonly collaborationObligations: ReadonlyArray<string>;
  readonly updatedAt: string;
}

export interface AcceptanceEvaluation {
  readonly projection: CollaborativeAcceptanceProjection;
  readonly currentAssessments: ReadonlyMap<
    CollaborativeAcceptanceAssessmentRole,
    CollaborativeAcceptanceAssessment | null
  >;
}

export type CandidateTransitionError = "candidate-epoch-not-increasing";

export type CandidateTransitionResult =
  | {
      readonly ok: true;
      readonly acceptanceCase: CollaborativeAcceptanceCase;
    }
  | { readonly ok: false; readonly error: CandidateTransitionError };

export const advanceAcceptanceCandidate = (
  acceptanceCase: CollaborativeAcceptanceCase,
  candidate: CollaborativeAcceptanceCandidate,
): CandidateTransitionResult =>
  candidate.reviewEpoch > acceptanceCase.currentCandidate.reviewEpoch
    ? {
        ok: true,
        acceptanceCase: {
          ...acceptanceCase,
          contractRevision: candidate.contractRevision,
          currentCandidate: candidate,
          updatedAt: candidate.createdAt,
        },
      }
    : { ok: false, error: "candidate-epoch-not-increasing" };

const assessmentRoles: ReadonlyArray<CollaborativeAcceptanceAssessmentRole> = [
  "child-implementer",
  "parent-reviewer",
];

const hasCandidateProvenance = (
  candidate: CollaborativeAcceptanceCandidate,
  assessment: CollaborativeAcceptanceAssessment,
): boolean =>
  assessment.candidateId === candidate.candidateId &&
  assessment.reviewEpoch === candidate.reviewEpoch &&
  assessment.headSha === candidate.headSha &&
  assessment.contractRevision === candidate.contractRevision &&
  assessment.reviewWorkflow.identity === candidate.reviewWorkflow.identity &&
  assessment.reviewWorkflow.version === candidate.reviewWorkflow.version;

export const isCurrentAcceptanceAssessment = (
  candidate: CollaborativeAcceptanceCandidate,
  assessment: CollaborativeAcceptanceAssessment,
): boolean =>
  assessment.kind === "attestation" &&
  (assessment.outcome === "pass" ||
    assessment.outcome === "fail" ||
    assessment.outcome === "inconclusive") &&
  hasCandidateProvenance(candidate, assessment);

export const staleAcceptanceAssessmentIds = (
  candidate: CollaborativeAcceptanceCandidate,
  assessments: ReadonlyArray<CollaborativeAcceptanceAssessment>,
): ReadonlyArray<CollaborativeAcceptanceAssessment["assessmentId"]> =>
  assessments
    .filter(
      (assessment) =>
        assessment.kind === "attestation" && !hasCandidateProvenance(candidate, assessment),
    )
    .map((assessment) => assessment.assessmentId);

const latestCurrentAssessment = (
  candidate: CollaborativeAcceptanceCandidate,
  caseId: CollaborativeAcceptanceCase["caseId"],
  assessments: ReadonlyArray<CollaborativeAcceptanceAssessment>,
  role: CollaborativeAcceptanceAssessmentRole,
): CollaborativeAcceptanceAssessment | null => {
  const current = assessments
    .filter(
      (assessment) =>
        assessment.caseId === caseId &&
        assessment.role === role &&
        isCurrentAcceptanceAssessment(candidate, assessment),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return current[0] ?? null;
};

const currentCriteriaEvidence = (
  input: AcceptanceEvaluationInput,
  criterionId: string,
  allowedEvidenceKinds: ReadonlyArray<CollaborativeAcceptanceEvidence["kind"]>,
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const item of input.evidence) {
    if (
      item.caseId === input.case.caseId &&
      item.candidateId === input.candidate.candidateId &&
      item.headSha === input.candidate.headSha &&
      item.criterionId === criterionId &&
      allowedEvidenceKinds.includes(item.kind) &&
      item.current &&
      item.complete
    ) {
      ids.add(item.evidenceId);
    }
  }
  return ids;
};

const criteriaAreSatisfied = (input: AcceptanceEvaluationInput): boolean => {
  return input.case.criteria
    .filter((criterion) => criterion.required)
    .every((criterion) => {
      const evidenceIds = currentCriteriaEvidence(
        input,
        criterion.criterionId,
        criterion.evidenceKinds,
      );
      return input.assessments.some(
        (assessment) =>
          assessment.kind === "attestation" &&
          assessment.outcome === "pass" &&
          assessment.role === "child-implementer" &&
          isCurrentAcceptanceAssessment(input.candidate, assessment) &&
          assessment.caseId === input.case.caseId &&
          assessment.criteriaEvidenceIds.some((id) => evidenceIds.has(id)),
      );
    });
};

const providerEvidenceIsCurrent = (
  candidate: CollaborativeAcceptanceCandidate,
  evidence: CollaborativeAcceptanceProviderEvidence | null,
): evidence is CollaborativeAcceptanceProviderEvidence =>
  evidence !== null &&
  evidence.candidateId === candidate.candidateId &&
  evidence.headSha === candidate.headSha;

const providerEvidenceIsComplete = (evidence: CollaborativeAcceptanceProviderEvidence): boolean => {
  const coverage = evidence.requiredCheckCoverage;
  return (
    evidence.complete &&
    evidence.reviewEvidenceComplete &&
    evidence.reviewThreadEvidenceComplete &&
    evidence.commentEvidenceComplete &&
    evidence.checkEvidenceComplete &&
    evidence.requiredChecksKnown &&
    coverage?.completeness === "complete" &&
    coverage.expected.length === new Set(coverage.observed.map((check) => check.name)).size &&
    coverage.expected.every((name) => coverage.observed.some((check) => check.name === name))
  );
};

const requiredChecksPass = (evidence: CollaborativeAcceptanceProviderEvidence): boolean =>
  evidence.requiredChecks.length > 0 &&
  evidence.requiredChecks.every(
    (check) =>
      check.headSha === evidence.headSha &&
      (check.status === "success" || check.status === "neutral" || check.status === "skipped"),
  );

const currentAssessmentMap = (
  caseId: CollaborativeAcceptanceCase["caseId"],
  candidate: CollaborativeAcceptanceCandidate,
  assessments: ReadonlyArray<CollaborativeAcceptanceAssessment>,
): ReadonlyMap<CollaborativeAcceptanceAssessmentRole, CollaborativeAcceptanceAssessment | null> =>
  new Map(
    assessmentRoles.map((role) => [
      role,
      latestCurrentAssessment(candidate, caseId, assessments, role),
    ]),
  );

export const evaluateAcceptance = (input: AcceptanceEvaluationInput): AcceptanceEvaluation => {
  const currentAssessments = currentAssessmentMap(
    input.case.caseId,
    input.candidate,
    input.assessments,
  );
  const child = currentAssessments.get("child-implementer") ?? null;
  const parent = currentAssessments.get("parent-reviewer") ?? null;
  const staleAssessmentIds = staleAcceptanceAssessmentIds(
    input.candidate,
    input.assessments.filter((assessment) => assessment.caseId === input.case.caseId),
  );
  const currentProviderEvidence = providerEvidenceIsCurrent(input.candidate, input.providerEvidence)
    ? input.providerEvidence
    : null;
  const providerComplete =
    currentProviderEvidence !== null && providerEvidenceIsComplete(currentProviderEvidence);
  const criteriaSatisfied = criteriaAreSatisfied(input);
  const currentAssessmentsPass = child?.outcome === "pass" && parent?.outcome === "pass";
  const hasAssessmentFailure =
    child?.outcome === "fail" ||
    child?.outcome === "inconclusive" ||
    parent?.outcome === "fail" ||
    parent?.outcome === "inconclusive";
  const reasons: string[] = [];

  let acceptanceLifecycle: AcceptanceEvaluation["projection"]["acceptanceLifecycle"];
  if (hasAssessmentFailure) {
    acceptanceLifecycle = "changes-requested";
    reasons.push("assessment-did-not-pass");
  } else if (child === null) {
    acceptanceLifecycle = "pending";
    reasons.push("child-assessment-missing");
  } else if (parent === null) {
    acceptanceLifecycle = "awaiting-review";
    reasons.push("parent-assessment-missing");
  } else if (!providerComplete) {
    acceptanceLifecycle = "monitoring";
    reasons.push("provider-evidence-incomplete");
  } else if (
    currentProviderEvidence.unresolvedActionableFindings > 0 ||
    (input.case.policy.commentPolicy !== "blocking-only" &&
      currentProviderEvidence.unresolvedReviewThreads > 0)
  ) {
    acceptanceLifecycle = "changes-requested";
    reasons.push("provider-findings-unresolved");
  } else if (!criteriaSatisfied || !currentAssessmentsPass) {
    acceptanceLifecycle = "verifying";
    if (!criteriaSatisfied) reasons.push("required-criteria-evidence-missing");
    if (!currentAssessmentsPass) reasons.push("current-attestations-incomplete");
  } else if (input.collaborationObligations.length > 0) {
    acceptanceLifecycle = "accepted";
    reasons.push("collaboration-obligations-open");
  } else {
    acceptanceLifecycle = "accepted";
  }

  const terminalProviderGates =
    currentProviderEvidence !== null &&
    providerComplete &&
    currentProviderEvidence.pullRequestState === "open" &&
    !currentProviderEvidence.isDraft &&
    currentProviderEvidence.mergeability === "mergeable" &&
    currentProviderEvidence.unresolvedActionableFindings === 0 &&
    currentProviderEvidence.unresolvedReviewThreads === 0 &&
    requiredChecksPass(currentProviderEvidence);
  const readyNow =
    (input.executionPhase === "verifying" || input.executionPhase === "monitoring") &&
    acceptanceLifecycle === "accepted" &&
    criteriaSatisfied &&
    currentAssessmentsPass &&
    input.collaborationObligations.length === 0 &&
    terminalProviderGates;

  if (readyNow) {
  } else if (
    acceptanceLifecycle === "accepted" &&
    currentProviderEvidence !== null &&
    providerComplete &&
    (!terminalProviderGates ||
      input.collaborationObligations.length > 0 ||
      (input.executionPhase !== "verifying" && input.executionPhase !== "monitoring"))
  ) {
    reasons.push("terminal-readiness-gate-missing");
  }

  const collaborationStatus =
    input.collaborationObligations.length > 0
      ? "human-input-required"
      : child === null
        ? "child-assessment-pending"
        : parent === null
          ? "parent-assessment-pending"
          : acceptanceLifecycle === "changes-requested"
            ? "changes-requested"
            : "none";

  const readiness = readyNow
    ? "ready-now"
    : currentProviderEvidence === null || !providerComplete
      ? "no-known-blockers"
      : "blocked";

  return {
    projection: {
      caseId: input.case.caseId,
      candidateId: input.candidate.candidateId,
      headSha: input.candidate.headSha,
      executionPhase: input.executionPhase,
      collaborationStatus,
      acceptanceLifecycle,
      readiness,
      reasons,
      staleAssessmentIds,
      updatedAt: input.updatedAt,
    },
    currentAssessments,
  };
};

export interface AcceptanceExchangeLedger {
  readonly budget: CollaborativeAcceptanceBudgets;
  readonly exchanges: ReadonlyArray<CollaborativeAcceptanceExchange>;
}

export type ExchangeTransitionError =
  | "exchange-budget-exhausted"
  | "model-spend-budget-exhausted"
  | "retry-budget-exhausted"
  | "exchange-not-found"
  | "invalid-exchange-transition";

export type ExchangeTransitionResult =
  | {
      readonly ok: true;
      readonly ledger: AcceptanceExchangeLedger;
      readonly exchange: CollaborativeAcceptanceExchange;
    }
  | { readonly ok: false; readonly error: ExchangeTransitionError };

const replaceExchange = (
  ledger: AcceptanceExchangeLedger,
  exchange: CollaborativeAcceptanceExchange,
): AcceptanceExchangeLedger => ({
  ...ledger,
  exchanges: ledger.exchanges.map((item) =>
    item.exchangeId === exchange.exchangeId ? exchange : item,
  ),
});

const countAdmissionDebits = (ledger: AcceptanceExchangeLedger): number =>
  ledger.exchanges.filter(
    (exchange) =>
      exchange.status === "reserved" ||
      exchange.status === "committed" ||
      exchange.status === "outcome-recorded" ||
      exchange.status === "completed" ||
      (exchange.status === "cancelled" && exchange.startedAt !== null),
  ).length;

const reservedModelSpend = (ledger: AcceptanceExchangeLedger): number =>
  ledger.exchanges
    .filter((exchange) => exchange.status !== "cancelled" || exchange.startedAt !== null)
    .reduce((total, exchange) => total + exchange.modelSpendCents, 0);

export const reserveExchange = (
  ledger: AcceptanceExchangeLedger,
  exchange: CollaborativeAcceptanceExchange,
): ExchangeTransitionResult => {
  const existing = ledger.exchanges.find((item) => item.exchangeId === exchange.exchangeId);
  if (existing !== undefined) {
    if (existing.status === "cancelled" && existing.startedAt === null) {
      const reopened = {
        ...existing,
        status: "reserved" as const,
        reservedAt: exchange.reservedAt,
        cancelledAt: null,
      };
      return { ok: true, ledger: replaceExchange(ledger, reopened), exchange: reopened };
    }
    if (existing.status === "outcome-recorded" && existing.retryCount < ledger.budget.retries) {
      const retry = {
        ...existing,
        status: "reserved" as const,
        retryCount: existing.retryCount + 1,
        reservedAt: exchange.reservedAt,
        startedAt: null,
        outcomeRecordedAt: null,
        completedAt: null,
        cancelledAt: null,
      };
      return { ok: true, ledger: replaceExchange(ledger, retry), exchange: retry };
    }
    if (existing.status === "outcome-recorded") {
      return { ok: false, error: "retry-budget-exhausted" };
    }
    return { ok: true, ledger, exchange: existing };
  }
  if (countAdmissionDebits(ledger) >= ledger.budget.exchanges) {
    return { ok: false, error: "exchange-budget-exhausted" };
  }
  if (reservedModelSpend(ledger) + exchange.modelSpendCents > ledger.budget.modelSpendCents) {
    return { ok: false, error: "model-spend-budget-exhausted" };
  }
  return {
    ok: true,
    ledger: { ...ledger, exchanges: [...ledger.exchanges, exchange] },
    exchange,
  };
};

export const startExchange = (
  ledger: AcceptanceExchangeLedger,
  exchangeId: CollaborativeAcceptanceExchange["exchangeId"],
  startedAt: string,
): ExchangeTransitionResult => {
  const exchange = ledger.exchanges.find((item) => item.exchangeId === exchangeId);
  if (exchange === undefined) return { ok: false, error: "exchange-not-found" };
  if (
    exchange.status === "committed" ||
    exchange.status === "outcome-recorded" ||
    exchange.status === "completed" ||
    (exchange.status === "cancelled" && exchange.startedAt !== null)
  ) {
    return { ok: true, ledger, exchange };
  }
  if (exchange.status !== "reserved") {
    return { ok: false, error: "invalid-exchange-transition" };
  }
  if (reservedModelSpend(ledger) > ledger.budget.modelSpendCents) {
    return { ok: false, error: "model-spend-budget-exhausted" };
  }
  const committed = { ...exchange, status: "committed" as const, startedAt };
  return { ok: true, ledger: replaceExchange(ledger, committed), exchange: committed };
};

export const recordExchangeOutcome = (
  ledger: AcceptanceExchangeLedger,
  exchangeId: CollaborativeAcceptanceExchange["exchangeId"],
  outcomeRecordedAt: string,
): ExchangeTransitionResult => {
  const exchange = ledger.exchanges.find((item) => item.exchangeId === exchangeId);
  if (exchange === undefined) return { ok: false, error: "exchange-not-found" };
  if (exchange.status === "outcome-recorded" || exchange.status === "completed") {
    return { ok: true, ledger, exchange };
  }
  if (exchange.status !== "committed") {
    return { ok: false, error: "invalid-exchange-transition" };
  }
  const recorded = { ...exchange, status: "outcome-recorded" as const, outcomeRecordedAt };
  return { ok: true, ledger: replaceExchange(ledger, recorded), exchange: recorded };
};

export const completeExchange = (
  ledger: AcceptanceExchangeLedger,
  exchangeId: CollaborativeAcceptanceExchange["exchangeId"],
  completedAt: string,
): ExchangeTransitionResult => {
  const exchange = ledger.exchanges.find((item) => item.exchangeId === exchangeId);
  if (exchange === undefined) return { ok: false, error: "exchange-not-found" };
  if (exchange.status === "completed") return { ok: true, ledger, exchange };
  if (exchange.status !== "outcome-recorded") {
    return { ok: false, error: "invalid-exchange-transition" };
  }
  const completed = { ...exchange, status: "completed" as const, completedAt };
  return { ok: true, ledger: replaceExchange(ledger, completed), exchange: completed };
};

export const cancelExchange = (
  ledger: AcceptanceExchangeLedger,
  exchangeId: CollaborativeAcceptanceExchange["exchangeId"],
  cancelledAt: string,
): ExchangeTransitionResult => {
  const exchange = ledger.exchanges.find((item) => item.exchangeId === exchangeId);
  if (exchange === undefined) return { ok: false, error: "exchange-not-found" };
  if (exchange.status === "cancelled") return { ok: true, ledger, exchange };
  if (exchange.status !== "reserved" && exchange.status !== "committed") {
    return { ok: false, error: "invalid-exchange-transition" };
  }
  const cancelled = { ...exchange, status: "cancelled" as const, cancelledAt };
  return { ok: true, ledger: replaceExchange(ledger, cancelled), exchange: cancelled };
};

export const exchangeStatusIsTerminal = (status: CollaborativeAcceptanceExchangeStatus): boolean =>
  status === "completed" || status === "cancelled";
