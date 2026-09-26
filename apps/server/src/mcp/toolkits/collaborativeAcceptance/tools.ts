import {
  CollaborativeAcceptanceAssessment,
  CollaborativeAcceptanceCandidateSubmission,
  CollaborativeAcceptanceError,
  CollaborativeAcceptancePauseReason,
  CollaborativeAcceptanceStatus,
  CollaborativeAcceptanceCaseId,
  CollaborationRequestId,
  PullRequestMonitorFeedbackItemId,
  PullRequestMonitorFeedbackReportDisposition,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { CollaborativeAcceptanceCoordinator } from "../../../collaborativeAcceptance/Coordinator.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  CollaborativeAcceptanceCoordinator,
  ProjectionSnapshotQuery,
];

export const CollaborativeAcceptanceSubmitCandidateTool = Tool.make("acceptance_submit_candidate", {
  description:
    "Submit an immutable acceptance candidate with explicit PR, contract, workflow, coverage, and initial evidence provenance. A child turn completing is not a review trigger.",
  parameters: CollaborativeAcceptanceCandidateSubmission,
  success: CollaborativeAcceptanceStatus,
  failure: CollaborativeAcceptanceError,
  dependencies,
}).annotate(Tool.Title, "Submit acceptance candidate");

const CaseInput = Schema.Struct({ caseId: CollaborativeAcceptanceCaseId });

export const CollaborativeAcceptanceReviewTool = Tool.make("acceptance_request_review", {
  description:
    "Request one canonical acceptance review for the current candidate. Equivalent active or completed reviews are deduplicated.",
  parameters: CaseInput,
  success: CollaborativeAcceptanceStatus,
  failure: CollaborativeAcceptanceError,
  dependencies,
}).annotate(Tool.Title, "Request acceptance review");

const CollaborationRequestInput = Schema.Struct({
  caseId: CollaborativeAcceptanceCaseId,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
});

export const CollaborativeAcceptanceClarificationTool = Tool.make(
  "acceptance_request_clarification",
  {
    description: "Queue a blocking clarification request through the canonical collaboration path.",
    parameters: CollaborationRequestInput,
    success: Schema.Void,
    failure: CollaborativeAcceptanceError,
    dependencies,
  },
).annotate(Tool.Title, "Request acceptance clarification");

export const CollaborativeAcceptanceDecisionTool = Tool.make("acceptance_request_decision", {
  description: "Queue a blocking decision request through the canonical collaboration path.",
  parameters: CollaborationRequestInput,
  success: Schema.Void,
  failure: CollaborativeAcceptanceError,
  dependencies,
}).annotate(Tool.Title, "Request acceptance decision");

export const CollaborativeAcceptanceRespondTool = Tool.make("acceptance_respond", {
  description:
    "Respond to a correlated acceptance collaboration request. The response is queued and consumed only by a newer sender execution generation.",
  parameters: Schema.Struct({
    requestId: CollaborationRequestId,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
    outcome: Schema.Literals(["completed", "cancelled", "needs-human"]),
  }),
  success: Schema.Void,
  failure: CollaborativeAcceptanceError,
  dependencies,
}).annotate(Tool.Title, "Respond to acceptance request");

export const CollaborativeAcceptanceDispositionTool = Tool.make("acceptance_disposition_finding", {
  description:
    "Disposition one durable review finding through the PR-monitor ledger. `needs-human` never satisfies acceptance.",
  parameters: Schema.Struct({
    caseId: CollaborativeAcceptanceCaseId,
    itemId: PullRequestMonitorFeedbackItemId,
    disposition: PullRequestMonitorFeedbackReportDisposition,
    note: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  }),
  success: Schema.Unknown,
  failure: CollaborativeAcceptanceError,
  dependencies,
}).annotate(Tool.Title, "Disposition acceptance finding");

export const CollaborativeAcceptanceAssessmentTool = Tool.make("acceptance_submit_assessment", {
  description:
    "Submit a child or parent assessment bound to the immutable current candidate, head, contract, and workflow provenance.",
  parameters: Schema.Struct({
    caseId: CollaborativeAcceptanceCaseId,
    assessment: CollaborativeAcceptanceAssessment,
  }),
  success: CollaborativeAcceptanceStatus,
  failure: CollaborativeAcceptanceError,
  dependencies,
}).annotate(Tool.Title, "Submit acceptance assessment");

export const CollaborativeAcceptanceStatusTool = Tool.make("acceptance_status", {
  description:
    "Read the durable acceptance projection, current candidate, exchange ledger, assessments, and provider evidence state.",
  parameters: CaseInput,
  success: CollaborativeAcceptanceStatus,
  failure: CollaborativeAcceptanceError,
  dependencies,
})
  .annotate(Tool.Title, "Read acceptance status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const CollaborativeAcceptancePauseTool = Tool.make("acceptance_pause", {
  description: "Pause acceptance automation with a typed durable reason.",
  parameters: Schema.Struct({
    caseId: CollaborativeAcceptanceCaseId,
    reason: CollaborativeAcceptancePauseReason,
  }),
  success: CollaborativeAcceptanceStatus,
  failure: CollaborativeAcceptanceError,
  dependencies,
}).annotate(Tool.Title, "Pause acceptance automation");

export const CollaborativeAcceptanceResumeTool = Tool.make("acceptance_resume", {
  description: "Resume acceptance automation without changing immutable candidate provenance.",
  parameters: CaseInput,
  success: CollaborativeAcceptanceStatus,
  failure: CollaborativeAcceptanceError,
  dependencies,
}).annotate(Tool.Title, "Resume acceptance automation");

export const CollaborativeAcceptanceToolkit = Toolkit.make(
  CollaborativeAcceptanceSubmitCandidateTool,
  CollaborativeAcceptanceReviewTool,
  CollaborativeAcceptanceClarificationTool,
  CollaborativeAcceptanceDecisionTool,
  CollaborativeAcceptanceRespondTool,
  CollaborativeAcceptanceDispositionTool,
  CollaborativeAcceptanceAssessmentTool,
  CollaborativeAcceptanceStatusTool,
  CollaborativeAcceptancePauseTool,
  CollaborativeAcceptanceResumeTool,
);
