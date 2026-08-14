import type {
  PullRequestMonitorActionableEventKind,
  PullRequestMonitorSnapshot,
} from "@t3tools/contracts";

/**
 * Whether a durable finding is still worth an owner's attention, judged only against fresh
 * provider state. Agent prose never resolves a finding; the provider does.
 */
export type FeedbackActionability =
  | { readonly kind: "actionable" }
  | { readonly kind: "resolved-upstream"; readonly detail: string }
  | { readonly kind: "superseded"; readonly detail: string };

const ACTIONABLE: FeedbackActionability = { kind: "actionable" };

export interface ReconcilableFeedbackItem {
  readonly kind: PullRequestMonitorActionableEventKind;
  readonly stableKey: string;
}

/** `${kind}:${sourceId ?? detail ?? "na"}` — see eventStableKey in the feedback service. */
export function feedbackSourceIdOf(stableKey: string): string | null {
  const separator = stableKey.indexOf(":");
  if (separator < 0) return null;
  const sourceId = stableKey.slice(separator + 1);
  return sourceId.length === 0 || sourceId === "na" ? null : sourceId;
}

function reconcileReviewComment(
  sourceId: string | null,
  snapshot: PullRequestMonitorSnapshot,
): FeedbackActionability {
  if (sourceId === null) return ACTIONABLE;

  const thread = snapshot.reviewThreads.find((candidate) => candidate.id === sourceId);
  if (thread) {
    if (thread.resolved) return { kind: "resolved-upstream", detail: "review thread resolved" };
    if (thread.latestCommentByViewer) {
      return { kind: "resolved-upstream", detail: "latest reply is ours" };
    }
    return ACTIONABLE;
  }

  const comment = snapshot.issueComments.find((candidate) => candidate.id === sourceId);
  if (comment) {
    return comment.authoredByViewer
      ? { kind: "resolved-upstream", detail: "comment authored by us" }
      : ACTIONABLE;
  }

  // Absence only proves resolution when we actually saw every page.
  if (snapshot.completeness.reviewThreadsComplete && snapshot.completeness.issueCommentsComplete) {
    return { kind: "superseded", detail: "comment no longer present" };
  }
  return ACTIONABLE;
}

function reconcileChangesRequested(
  sourceId: string | null,
  snapshot: PullRequestMonitorSnapshot,
): FeedbackActionability {
  if (sourceId === null) return ACTIONABLE;
  const review = snapshot.reviews.find((candidate) => candidate.id === sourceId);
  if (!review) {
    return snapshot.completeness.reviewsComplete
      ? { kind: "superseded", detail: "review no longer present" }
      : ACTIONABLE;
  }
  if (review.state !== "changes-requested") {
    return { kind: "resolved-upstream", detail: `review is now ${review.state}` };
  }
  const newerByAuthor = snapshot.reviews.filter(
    (candidate) =>
      candidate.author.login === review.author.login &&
      (candidate.submittedAt ?? "") > (review.submittedAt ?? "") &&
      (candidate.state === "approved" || candidate.state === "dismissed"),
  );
  if (newerByAuthor.length > 0) {
    return { kind: "resolved-upstream", detail: "reviewer submitted a newer verdict" };
  }
  return ACTIONABLE;
}

function reconcileCheck(
  sourceId: string | null,
  detailName: string | null,
  snapshot: PullRequestMonitorSnapshot,
): FeedbackActionability {
  const atHead = snapshot.checkRuns.filter((check) => check.headSha === snapshot.headSha);
  const byId = sourceId === null ? undefined : atHead.find((check) => check.id === sourceId);
  const candidate =
    byId ?? (detailName === null ? undefined : atHead.find((check) => check.name === detailName));

  if (!candidate) {
    if (atHead.length === 0) return ACTIONABLE;
    return snapshot.completeness.checksComplete
      ? { kind: "superseded", detail: "check run no longer reported at head" }
      : ACTIONABLE;
  }
  if (candidate.status === "success" || candidate.status === "neutral") {
    return { kind: "resolved-upstream", detail: `check ${candidate.name} is ${candidate.status}` };
  }
  if (candidate.status === "skipped") {
    return { kind: "resolved-upstream", detail: `check ${candidate.name} was skipped` };
  }
  return ACTIONABLE;
}

/**
 * Reconcile one durable finding against a fresh snapshot. Incomplete provider evidence is
 * treated as "still actionable" so a paging gap can never silently drop real feedback.
 */
export function reconcileFeedbackItem(
  item: ReconcilableFeedbackItem,
  snapshot: PullRequestMonitorSnapshot,
  options?: {
    readonly checkName?: string | null;
    /**
     * Head the item was observed against, supplied only while a claimed fix awaits
     * verification. A moved head is the evidence that a claim was actually pushed.
     */
    readonly claimHeadSha?: string | null;
  },
): FeedbackActionability {
  const sourceId = feedbackSourceIdOf(item.stableKey);
  switch (item.kind) {
    case "new-review-comment":
      return reconcileReviewComment(sourceId, snapshot);
    case "changes-requested-review":
      return reconcileChangesRequested(sourceId, snapshot);
    case "check-failed":
      return reconcileCheck(sourceId, options?.checkName ?? null, snapshot);
    case "behind-base":
      return (snapshot.behindBaseBy ?? 0) > 0
        ? ACTIONABLE
        : { kind: "resolved-upstream", detail: "branch is no longer behind base" };
    case "review-finding": {
      // A reviewer-submitted finding has no host state to observe: only new commits can
      // show that a claimed fix landed.
      const claimHeadSha = options?.claimHeadSha ?? null;
      return claimHeadSha !== null && claimHeadSha !== snapshot.headSha
        ? { kind: "resolved-upstream", detail: "head advanced after the claimed fix" }
        : ACTIONABLE;
    }
    case "state-changed":
      return { kind: "superseded", detail: "state change is not remediation work" };
    default:
      return ACTIONABLE;
  }
}
