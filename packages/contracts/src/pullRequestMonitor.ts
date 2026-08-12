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

export const formatPullRequestMonitorCanonicalKey = (key: PullRequestMonitorCanonicalKey): string =>
  `${key.provider}:${key.host}:${key.repository}#${key.number}`;

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
  "changes-requested",
  "unresolved-thread",
  "behind-base",
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
  "behind-base",
  "state-changed",
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
});
export type PullRequestMonitorStartInput = typeof PullRequestMonitorStartInput.Type;

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

export const PullRequestMonitorFeedbackDisposition = Schema.Literals([
  "accepted",
  "rejected",
  "resolved",
  "needs-human",
]);
export type PullRequestMonitorFeedbackDisposition =
  typeof PullRequestMonitorFeedbackDisposition.Type;

export const PullRequestMonitorFeedbackItemStatus = Schema.Literals(["open", "closed"]);
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
  /** Bound payload excerpt from the latest revision. */
  summary: Schema.String.check(Schema.isMaxLength(500)),
});
export type PullRequestMonitorFeedbackItem = typeof PullRequestMonitorFeedbackItem.Type;

export const PullRequestMonitorFeedbackRevision = Schema.Struct({
  id: PullRequestMonitorFeedbackRevisionId,
  itemId: PullRequestMonitorFeedbackItemId,
  revisionNumber: PositiveInt,
  sourceRevision: TrimmedNonEmptyString,
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
  disposition: PullRequestMonitorFeedbackDisposition,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  reporterThreadId: Schema.optional(ThreadId),
});
export type PullRequestMonitorReportInput = typeof PullRequestMonitorReportInput.Type;

export const PullRequestMonitorReportResult = Schema.Struct({
  item: PullRequestMonitorFeedbackItem,
  report: PullRequestMonitorFeedbackReport,
  recheckRequested: Schema.Boolean,
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
  items: Schema.Array(PullRequestMonitorFeedbackItem),
  recentDeliveries: Schema.Array(PullRequestMonitorFeedbackDelivery),
  recentReports: Schema.Array(PullRequestMonitorFeedbackReport),
});
export type PullRequestMonitorContextResult = typeof PullRequestMonitorContextResult.Type;

export const PullRequestMonitorStatusResult = Schema.Struct({
  monitor: Schema.NullOr(PullRequestMonitorRecord),
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

export class PullRequestMonitorError extends Schema.TaggedErrorClass<PullRequestMonitorError>()(
  "PullRequestMonitorError",
  {
    message: Schema.String,
    monitorId: Schema.optional(PullRequestMonitorId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
