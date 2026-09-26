import type {
  PullRequestMonitorAcceptanceProvenance,
  PullRequestMonitorAcceptanceProvenanceInput,
  PullRequestMonitorFeedbackItemId,
  PullRequestMonitorFeedbackRevisionId,
  PullRequestMonitorId,
} from "@t3tools/contracts";

const freezeArray = <T>(values: ReadonlyArray<T>): ReadonlyArray<T> => Object.freeze([...values]);

/**
 * Builds the immutable bridge from monitor evidence to a Collaborative Acceptance record.
 * Every value is supplied by the reviewed revision; this function never reads mutable monitor,
 * pull-request, or thread state.
 */
export const buildMonitorAcceptanceProvenance = (input: {
  readonly monitorId: PullRequestMonitorId;
  readonly findingId: PullRequestMonitorFeedbackItemId;
  readonly findingRevisionId: PullRequestMonitorFeedbackRevisionId;
  readonly provenance: PullRequestMonitorAcceptanceProvenanceInput;
}): PullRequestMonitorAcceptanceProvenance => {
  const provenance = input.provenance;
  const workflow = Object.freeze({ ...provenance.workflow });
  const requiredCoverage = Object.freeze({
    required: freezeArray(provenance.requiredCoverage.required),
    covered: freezeArray(provenance.requiredCoverage.covered),
    applicability: provenance.requiredCoverage.applicability,
  });
  const transportContext =
    provenance.transportContext === null ? null : Object.freeze({ ...provenance.transportContext });
  const location = provenance.location === null ? null : Object.freeze({ ...provenance.location });

  return Object.freeze({
    monitorId: input.monitorId,
    caseId: provenance.caseId,
    candidateId: provenance.candidateId,
    transportContext,
    headSha: provenance.headSha,
    sourceRevision: provenance.sourceRevision,
    findingId: input.findingId,
    findingRevisionId: input.findingRevisionId,
    workflow,
    requiredCoverage,
    diffHash: provenance.diffHash,
    location,
  });
};
