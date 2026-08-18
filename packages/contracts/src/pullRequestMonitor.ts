import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  PullRequestMonitorId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  PullRequestCheckStatus,
  PullRequestMergeability,
  PullRequestRef,
  PullRequestState,
} from "./pullRequest.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

/**
 * Canonical identity for one change request on one host. Monitors are unique per this key so
 * two threads cannot both poll the same PR under different local refs.
 */
export const PullRequestMonitorCanonicalKey = Schema.Struct({
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type PullRequestMonitorCanonicalKey = typeof PullRequestMonitorCanonicalKey.Type;

export const PullRequestMonitorLifecycleStatus = Schema.Literals([
  "monitoring",
  "ready",
  "terminal",
  "error",
  "stopped",
]);
export type PullRequestMonitorLifecycleStatus = typeof PullRequestMonitorLifecycleStatus.Type;

export const PullRequestMonitorReadinessLabel = Schema.Literals([
  "ready-to-merge",
  "no-known-blockers",
  "blocked",
]);
export type PullRequestMonitorReadinessLabel = typeof PullRequestMonitorReadinessLabel.Type;

export const PullRequestMonitorBlockerKind = Schema.Literals([
  "terminal",
  "draft",
  "mergeability",
  "checks-missing",
  "check-pending",
  "check-failed",
  /** A cancelled run never proved success; it blocks until it is re-run. */
  "check-cancelled",
  "changes-requested",
  "unresolved-thread",
  /** Legacy durable blocker. Base distance is now informational and never blocks readiness. */
  "behind-base",
  /** Durable monitor state: feedback the owner has not dispositioned yet. */
  "feedback-open",
  /** Feedback an agent claimed resolved that fresh provider state has not confirmed. */
  "feedback-unverified",
  /** Feedback escalated to a human. */
  "feedback-needs-human",
  /** A remediation wake is queued or retrying and has not reached the owner. */
  "feedback-delivery-pending",
]);
export type PullRequestMonitorBlockerKind = typeof PullRequestMonitorBlockerKind.Type;

export const PullRequestMonitorBlocker = Schema.Struct({
  kind: PullRequestMonitorBlockerKind,
  detail: Schema.optional(Schema.String),
});
export type PullRequestMonitorBlocker = typeof PullRequestMonitorBlocker.Type;

export const PullRequestMonitorReadiness = Schema.Struct({
  ready: Schema.Boolean,
  label: PullRequestMonitorReadinessLabel,
  blockers: Schema.Array(PullRequestMonitorBlocker),
});
export type PullRequestMonitorReadiness = typeof PullRequestMonitorReadiness.Type;

export const PullRequestMonitorActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  kind: Schema.Literals(["user", "bot", "unknown"]),
});
export type PullRequestMonitorActor = typeof PullRequestMonitorActor.Type;

export const PullRequestMonitorReviewState = Schema.Literals([
  "approved",
  "changes-requested",
  "commented",
  "dismissed",
  "pending",
]);
export type PullRequestMonitorReviewState = typeof PullRequestMonitorReviewState.Type;

export const PullRequestMonitorReview = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: PullRequestMonitorActor,
  state: PullRequestMonitorReviewState,
  submittedAt: Schema.NullOr(IsoDateTime),
  commitSha: Schema.NullOr(TrimmedNonEmptyString),
  /** Bound excerpt; full body is available via typed context tools, never free-form prompt stuffing. */
  bodyExcerpt: Schema.String.check(Schema.isMaxLength(500)),
});
export type PullRequestMonitorReview = typeof PullRequestMonitorReview.Type;

export const PullRequestMonitorReviewThread = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: PullRequestMonitorActor,
  path: Schema.NullOr(Schema.String),
  line: Schema.NullOr(PositiveInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolved: Schema.Boolean,
  latestCommentByViewer: Schema.Boolean,
  bodyExcerpt: Schema.String.check(Schema.isMaxLength(500)),
});
export type PullRequestMonitorReviewThread = typeof PullRequestMonitorReviewThread.Type;

export const PullRequestMonitorIssueComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: PullRequestMonitorActor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Self-authored comments are our own output and must never wake the owner. */
  authoredByViewer: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  bodyExcerpt: Schema.String.check(Schema.isMaxLength(500)),
});
export type PullRequestMonitorIssueComment = typeof PullRequestMonitorIssueComment.Type;

export const PullRequestMonitorCheckRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: PullRequestCheckStatus,
  headSha: TrimmedNonEmptyString,
  url: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
});
export type PullRequestMonitorCheckRun = typeof PullRequestMonitorCheckRun.Type;

/**
 * Completeness flags tell readiness whether missing evidence means "unknown" rather than
 * "green". Providers that cannot prove required-check coverage must leave that flag false.
 */
export const PullRequestMonitorCompleteness = Schema.Struct({
  reviewsComplete: Schema.Boolean,
  reviewThreadsComplete: Schema.Boolean,
  issueCommentsComplete: Schema.Boolean,
  checksComplete: Schema.Boolean,
  requiredChecksKnown: Schema.Boolean,
  /**
   * Whether the base comparison was actually read. A failed compare leaves `behindBaseBy`
   * null, which is "unknown", not "up to date"; older snapshots decode as unknown.
   */
  baseComparisonKnown: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type PullRequestMonitorCompleteness = typeof PullRequestMonitorCompleteness.Type;

/**
 * Provider-neutral monitoring snapshot. Stable source IDs and a content revision let the
 * durable monitor diff without depending on UI cache identity.
 */
export const PullRequestMonitorSnapshot = Schema.Struct({
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  headSha: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  mergeability: PullRequestMergeability,
  behindBaseBy: Schema.NullOr(NonNegativeInt),
  titleExcerpt: Schema.String.check(Schema.isMaxLength(200)),
  url: TrimmedNonEmptyString,
  fetchedAt: IsoDateTime,
  sourceRevision: TrimmedNonEmptyString,
  completeness: PullRequestMonitorCompleteness,
  reviews: Schema.Array(PullRequestMonitorReview),
  reviewThreads: Schema.Array(PullRequestMonitorReviewThread),
  issueComments: Schema.Array(PullRequestMonitorIssueComment),
  checkRuns: Schema.Array(PullRequestMonitorCheckRun),
});
export type PullRequestMonitorSnapshot = typeof PullRequestMonitorSnapshot.Type;

export const PullRequestMonitorActionableEventKind = Schema.Literals([
  "new-review-comment",
  "changes-requested-review",
  "check-failed",
  "merge-conflict",
  /** Legacy durable event. Base distance is now informational and never emitted. */
  "behind-base",
  "state-changed",
  /** Structured finding submitted by a review agent, not observed on the host. */
  "review-finding",
]);
export type PullRequestMonitorActionableEventKind =
  typeof PullRequestMonitorActionableEventKind.Type;

export const PullRequestMonitorActionableEvent = Schema.Struct({
  kind: PullRequestMonitorActionableEventKind,
  sourceId: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  edited: Schema.optional(Schema.Boolean),
});
export type PullRequestMonitorActionableEvent = typeof PullRequestMonitorActionableEvent.Type;

export const PullRequestMonitorRecord = Schema.Struct({
  id: PullRequestMonitorId,
  canonicalKey: TrimmedNonEmptyString,
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  projectId: ProjectId,
  ownerThreadId: Schema.NullOr(ThreadId),
  linkedReviewThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  status: PullRequestMonitorLifecycleStatus,
  enabled: Schema.Boolean,
  readiness: Schema.NullOr(PullRequestMonitorReadiness),
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  sourceRevision: Schema.NullOr(TrimmedNonEmptyString),
  lastPolledAt: Schema.NullOr(IsoDateTime),
  nextPollAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  pollFailureCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  stoppedAt: Schema.NullOr(IsoDateTime),
});
export type PullRequestMonitorRecord = typeof PullRequestMonitorRecord.Type;

export const PullRequestMonitorStartInput = Schema.Struct({
  ...PullRequestRef.fields,
  ownerThreadId: Schema.optional(ThreadId),
  requireAssociatedOwner: Schema.optional(Schema.Boolean),
  ownerMode: Schema.optional(Schema.Literals(["preserve", "observe-only"])),
});
export type PullRequestMonitorStartInput = typeof PullRequestMonitorStartInput.Type;

export const PullRequestMonitorOwnerCandidate = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
});
export type PullRequestMonitorOwnerCandidate = typeof PullRequestMonitorOwnerCandidate.Type;

export const PullRequestMonitorStopInput = Schema.Struct({
  monitorId: Schema.optional(PullRequestMonitorId),
  reference: Schema.optional(PullRequestRef),
});
export type PullRequestMonitorStopInput = typeof PullRequestMonitorStopInput.Type;

export const PullRequestMonitorStatusInput = Schema.Struct({
  monitorId: Schema.optional(PullRequestMonitorId),
  reference: Schema.optional(PullRequestRef),
});
export type PullRequestMonitorStatusInput = typeof PullRequestMonitorStatusInput.Type;

export const PullRequestMonitorListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  enabledOnly: Schema.optional(Schema.Boolean),
});
export type PullRequestMonitorListInput = typeof PullRequestMonitorListInput.Type;

/**
 * Dispositions an agent or human may report. `resolved` is only a claim: it moves an item to
 * `verifying` until fresh provider state confirms the finding is gone.
 */
export const PullRequestMonitorFeedbackReportDisposition = Schema.Literals([
  "accepted",
  "rejected",
  "resolved",
  "needs-human",
]);
export type PullRequestMonitorFeedbackReportDisposition =
  typeof PullRequestMonitorFeedbackReportDisposition.Type;

/** Stored disposition, including the provider-derived outcomes only the server may write. */
export const PullRequestMonitorFeedbackDisposition = Schema.Literals([
  "accepted",
  "rejected",
  "resolved",
  "needs-human",
  /** Fresh provider state no longer reports the finding. */
  "resolved-upstream",
  /** The finding no longer applies to the current head/source revision. */
  "superseded",
]);
export type PullRequestMonitorFeedbackDisposition =
  typeof PullRequestMonitorFeedbackDisposition.Type;

export const PullRequestMonitorFeedbackItemStatus = Schema.Literals([
  "open",
  /** An agent claimed resolution; awaiting provider confirmation. */
  "verifying",
  "closed",
]);
export type PullRequestMonitorFeedbackItemStatus = typeof PullRequestMonitorFeedbackItemStatus.Type;

export const PullRequestMonitorFeedbackItemId = TrimmedNonEmptyString.pipe(
  Schema.brand("PullRequestMonitorFeedbackItemId"),
);
export type PullRequestMonitorFeedbackItemId = typeof PullRequestMonitorFeedbackItemId.Type;

export const PullRequestMonitorFeedbackRevisionId = TrimmedNonEmptyString.pipe(
  Schema.brand("PullRequestMonitorFeedbackRevisionId"),
);
export type PullRequestMonitorFeedbackRevisionId = typeof PullRequestMonitorFeedbackRevisionId.Type;

export const PullRequestMonitorFeedbackDeliveryId = TrimmedNonEmptyString.pipe(
  Schema.brand("PullRequestMonitorFeedbackDeliveryId"),
);
export type PullRequestMonitorFeedbackDeliveryId = typeof PullRequestMonitorFeedbackDeliveryId.Type;

export const PullRequestMonitorFeedbackItem = Schema.Struct({
  id: PullRequestMonitorFeedbackItemId,
  monitorId: PullRequestMonitorId,
  stableKey: TrimmedNonEmptyString,
  kind: PullRequestMonitorActionableEventKind,
  status: PullRequestMonitorFeedbackItemStatus,
  disposition: Schema.NullOr(PullRequestMonitorFeedbackDisposition),
  dispositionNote: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  dispositionAt: Schema.NullOr(IsoDateTime),
  dispositionByThreadId: Schema.NullOr(ThreadId),
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  currentRevisionId: Schema.NullOr(PullRequestMonitorFeedbackRevisionId),
  /** Head the latest revision was observed against; evidence for verifying a claimed fix. */
  currentRevisionHeadSha: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Bound payload excerpt from the latest revision. */
  summary: Schema.String.check(Schema.isMaxLength(500)),
});
export type PullRequestMonitorFeedbackItem = typeof PullRequestMonitorFeedbackItem.Type;

export const PullRequestMonitorFeedbackRevision = Schema.Struct({
  id: PullRequestMonitorFeedbackRevisionId,
  itemId: PullRequestMonitorFeedbackItemId,
  revisionNumber: PositiveInt,
  sourceRevision: TrimmedNonEmptyString,
  /** Hash of the observed source payload; identity for replay-safe ingestion. */
  contentHash: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  summary: Schema.String.check(Schema.isMaxLength(500)),
  /** Structured untrusted payload; clients/MCP tools may render it. */
  payload: Schema.Unknown,
});
export type PullRequestMonitorFeedbackRevision = typeof PullRequestMonitorFeedbackRevision.Type;

export const PullRequestMonitorFeedbackDeliveryStatus = Schema.Literals([
  "pending",
  "delivered",
  "failed",
  "suppressed",
]);
export type PullRequestMonitorFeedbackDeliveryStatus =
  typeof PullRequestMonitorFeedbackDeliveryStatus.Type;

export const PullRequestMonitorFeedbackDelivery = Schema.Struct({
  id: PullRequestMonitorFeedbackDeliveryId,
  monitorId: PullRequestMonitorId,
  batchKey: TrimmedNonEmptyString,
  targetThreadId: ThreadId,
  commandId: TrimmedNonEmptyString,
  messageId: TrimmedNonEmptyString,
  revisionIds: Schema.Array(PullRequestMonitorFeedbackRevisionId),
  status: PullRequestMonitorFeedbackDeliveryStatus,
  attemptCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  deliveredAt: Schema.NullOr(IsoDateTime),
});
export type PullRequestMonitorFeedbackDelivery = typeof PullRequestMonitorFeedbackDelivery.Type;

export const PullRequestMonitorFeedbackReport = Schema.Struct({
  id: TrimmedNonEmptyString,
  monitorId: PullRequestMonitorId,
  itemId: PullRequestMonitorFeedbackItemId,
  disposition: PullRequestMonitorFeedbackDisposition,
  note: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  reporterThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type PullRequestMonitorFeedbackReport = typeof PullRequestMonitorFeedbackReport.Type;

export const PullRequestMonitorReportInput = Schema.Struct({
  monitorId: Schema.optional(PullRequestMonitorId),
  reference: Schema.optional(PullRequestRef),
  itemId: PullRequestMonitorFeedbackItemId,
  disposition: PullRequestMonitorFeedbackReportDisposition,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  reporterThreadId: Schema.optional(ThreadId),
});
export type PullRequestMonitorReportInput = typeof PullRequestMonitorReportInput.Type;

export const PullRequestMonitorReportResult = Schema.Struct({
  item: PullRequestMonitorFeedbackItem,
  report: PullRequestMonitorFeedbackReport,
  recheckRequested: Schema.Boolean,
  /** True when the claim still needs fresh provider confirmation before it can close. */
  awaitingVerification: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type PullRequestMonitorReportResult = typeof PullRequestMonitorReportResult.Type;

export const PullRequestMonitorContextInput = Schema.Struct({
  monitorId: Schema.optional(PullRequestMonitorId),
  reference: Schema.optional(PullRequestRef),
  includeClosed: Schema.optional(Schema.Boolean),
});
export type PullRequestMonitorContextInput = typeof PullRequestMonitorContextInput.Type;

export const PullRequestMonitorContextResult = Schema.Struct({
  monitor: Schema.NullOr(PullRequestMonitorRecord),
  latestSnapshot: Schema.NullOr(PullRequestMonitorSnapshot),
  /** Feedback items for this monitor. May include closed when includeClosed is set. */
  items: Schema.Array(PullRequestMonitorFeedbackItem),
  recentDeliveries: Schema.Array(PullRequestMonitorFeedbackDelivery),
  recentReports: Schema.Array(PullRequestMonitorFeedbackReport),
});
export type PullRequestMonitorContextResult = typeof PullRequestMonitorContextResult.Type;

export const PullRequestMonitorStatusResult = Schema.Struct({
  monitor: Schema.NullOr(PullRequestMonitorRecord),
  ownerCandidates: Schema.Array(PullRequestMonitorOwnerCandidate),
  latestSnapshot: Schema.NullOr(PullRequestMonitorSnapshot),
  recentEvents: Schema.Array(PullRequestMonitorActionableEvent),
  openFeedback: Schema.Array(PullRequestMonitorFeedbackItem),
  recentDeliveries: Schema.Array(PullRequestMonitorFeedbackDelivery),
  recentReports: Schema.Array(PullRequestMonitorFeedbackReport),
});
export type PullRequestMonitorStatusResult = typeof PullRequestMonitorStatusResult.Type;

export const PullRequestMonitorListResult = Schema.Struct({
  monitors: Schema.Array(PullRequestMonitorRecord),
});
export type PullRequestMonitorListResult = typeof PullRequestMonitorListResult.Type;

export const PullRequestMonitorMutationResult = Schema.Struct({
  monitor: PullRequestMonitorRecord,
});
export type PullRequestMonitorMutationResult = typeof PullRequestMonitorMutationResult.Type;

export const PullRequestMonitorTransferInput = Schema.Struct({
  monitorId: Schema.optional(PullRequestMonitorId),
  reference: Schema.optional(PullRequestRef),
  toThreadId: ThreadId,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type PullRequestMonitorTransferInput = typeof PullRequestMonitorTransferInput.Type;

/**
 * One structured review finding. Reviewers submit findings instead of prose so each one gets
 * its own durable id, revision, and disposition trail.
 */
export const PullRequestMonitorFinding = Schema.Struct({
  /** Reviewer-stable key; re-submitting the same key updates that finding instead of forking it. */
  key: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  detail: Schema.String.check(Schema.isMaxLength(2_000)),
  severity: Schema.Literals(["blocker", "major", "minor", "nit"]),
  path: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  line: Schema.optional(PositiveInt),
});
export type PullRequestMonitorFinding = typeof PullRequestMonitorFinding.Type;

export const PullRequestMonitorSubmitFindingsInput = Schema.Struct({
  reference: PullRequestRef,
  reviewThreadId: ThreadId,
  ownerThreadId: Schema.optional(ThreadId),
  summary: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  startMonitoring: Schema.optional(Schema.Boolean),
  findings: Schema.optional(Schema.Array(PullRequestMonitorFinding)),
});
export type PullRequestMonitorSubmitFindingsInput =
  typeof PullRequestMonitorSubmitFindingsInput.Type;

/** Durable identity assigned to each submitted finding. */
export const PullRequestMonitorSubmittedFinding = Schema.Struct({
  key: TrimmedNonEmptyString,
  itemId: PullRequestMonitorFeedbackItemId,
  revisionId: PullRequestMonitorFeedbackRevisionId,
  /** False when the identical finding was already recorded at this source revision. */
  created: Schema.Boolean,
});
export type PullRequestMonitorSubmittedFinding = typeof PullRequestMonitorSubmittedFinding.Type;

export const PullRequestMonitorSubmitFindingsResult = Schema.Struct({
  monitor: PullRequestMonitorRecord,
  linkedReviewThreadId: ThreadId,
  ownerThreadId: Schema.NullOr(ThreadId),
  monitoringStarted: Schema.Boolean,
  findings: Schema.Array(PullRequestMonitorSubmittedFinding).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type PullRequestMonitorSubmitFindingsResult =
  typeof PullRequestMonitorSubmitFindingsResult.Type;

export const PullRequestMonitorFallbackReason = Schema.Literals([
  "owner-missing",
  "owner-unavailable",
  "explicit",
  "worktree-unavailable",
]);
export type PullRequestMonitorFallbackReason = typeof PullRequestMonitorFallbackReason.Type;

/** Launch a fallback maintenance thread for a monitored PR. Never dual-owns. */
export const PullRequestMonitorLaunchFallbackInput = Schema.Struct({
  monitorId: Schema.optional(PullRequestMonitorId),
  reference: Schema.optional(PullRequestRef),
  reason: Schema.optional(PullRequestMonitorFallbackReason),
  /** When true, transfer even if the current owner thread still exists (human-approved). */
  force: Schema.optional(Schema.Boolean),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000))),
});
export type PullRequestMonitorLaunchFallbackInput =
  typeof PullRequestMonitorLaunchFallbackInput.Type;

export const PullRequestMonitorLaunchFallbackResult = Schema.Struct({
  monitor: PullRequestMonitorRecord,
  fallbackThreadId: ThreadId,
  previousOwnerThreadId: Schema.NullOr(ThreadId),
  launched: Schema.Boolean,
  skippedReason: Schema.NullOr(Schema.String),
  commandId: TrimmedNonEmptyString,
});
export type PullRequestMonitorLaunchFallbackResult =
  typeof PullRequestMonitorLaunchFallbackResult.Type;

export class PullRequestMonitorError extends Schema.TaggedErrorClass<PullRequestMonitorError>()(
  "PullRequestMonitorError",
  {
    message: Schema.String,
    monitorId: Schema.optional(PullRequestMonitorId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
