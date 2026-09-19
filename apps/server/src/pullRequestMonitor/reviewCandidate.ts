import type {
  PullRequestMonitorReviewCandidate,
  PullRequestMonitorReviewCoverage,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

export type ReviewCandidateMode = "full" | "delta";

export type ReviewCandidateEligibilityReason =
  | "initial"
  | "head-changed"
  | "contract-changed"
  | "workflow-changed"
  | "coverage-expanded"
  | "coverage-unknown"
  | "duplicate";

export interface ReviewCandidateEligibility {
  readonly eligible: boolean;
  readonly mode: ReviewCandidateMode | null;
  readonly reason: ReviewCandidateEligibilityReason;
}

const sortedUnique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values)].sort();

function coverageKey(coverage: PullRequestMonitorReviewCoverage): string {
  return JSON.stringify({
    required: sortedUnique(coverage.required),
    covered: sortedUnique(coverage.covered),
    applicability: coverage.applicability,
  });
}

/**
 * Stable request identity. Coverage is part of the key so a broader required review is not
 * incorrectly deduplicated against a narrower request for the same head.
 */
export function reviewCandidateKey(candidate: PullRequestMonitorReviewCandidate): string {
  const digest = NodeCrypto.createHash("sha256");
  digest.update(
    [
      candidate.candidateId,
      candidate.headSha,
      candidate.contractRevision,
      candidate.workflowId,
      candidate.workflowVersion,
      coverageKey(candidate.coverage),
    ].join("\0"),
  );
  return `review-candidate:${digest.digest("hex").slice(0, 32)}`;
}

export function dedupeReviewCandidates(
  candidates: ReadonlyArray<PullRequestMonitorReviewCandidate>,
): ReadonlyArray<PullRequestMonitorReviewCandidate> {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = reviewCandidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function coverageExpanded(
  previous: PullRequestMonitorReviewCoverage,
  current: PullRequestMonitorReviewCoverage,
): boolean {
  const previousRequired = new Set(previous.required);
  return current.required.some((coverage) => !previousRequired.has(coverage));
}

/**
 * Decide whether a candidate needs review without consulting turn completion. Unknown
 * applicability is intentionally conservative: only a full review can establish coverage.
 */
export function reviewCandidateEligibility(input: {
  readonly candidate: PullRequestMonitorReviewCandidate;
  readonly previous?: PullRequestMonitorReviewCandidate | null;
}): ReviewCandidateEligibility {
  const previous = input.previous ?? null;
  if (previous === null) {
    return { eligible: true, mode: "full", reason: "initial" };
  }

  if (reviewCandidateKey(previous) === reviewCandidateKey(input.candidate)) {
    return { eligible: false, mode: null, reason: "duplicate" };
  }

  if (
    input.candidate.coverage.applicability === "unknown" ||
    previous.coverage.applicability === "unknown"
  ) {
    return { eligible: true, mode: "full", reason: "coverage-unknown" };
  }

  if (previous.contractRevision !== input.candidate.contractRevision) {
    return { eligible: true, mode: "full", reason: "contract-changed" };
  }

  if (
    previous.workflowId !== input.candidate.workflowId ||
    previous.workflowVersion !== input.candidate.workflowVersion
  ) {
    return { eligible: true, mode: "full", reason: "workflow-changed" };
  }

  if (coverageExpanded(previous.coverage, input.candidate.coverage)) {
    return { eligible: true, mode: "full", reason: "coverage-expanded" };
  }

  if (previous.headSha !== input.candidate.headSha) {
    return { eligible: true, mode: "delta", reason: "head-changed" };
  }

  return { eligible: false, mode: null, reason: "duplicate" };
}
