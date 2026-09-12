import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  WorkflowRunInput,
} from "@t3tools/contracts";
import { REVIEW_CHANGES_WORKFLOW_ID } from "@t3tools/shared/workflows/reviewChanges";

export function buildPullRequestReviewWorkflowInput(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly pullRequestNumber: number;
  readonly idempotencyKey: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): WorkflowRunInput {
  return {
    workflowId: REVIEW_CHANGES_WORKFLOW_ID,
    threadId: input.threadId,
    projectId: input.projectId,
    cwd: input.cwd,
    input: {
      scope: "pull-request",
      pullRequestNumber: input.pullRequestNumber,
    },
    destinationMode: "child-chat",
    trigger: "manual",
    idempotencyKey: input.idempotencyKey,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
  };
}

export function reviewWorkflowDisabledReason(input: {
  readonly supported: boolean;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly isRepo: boolean;
  readonly cwd: string | null;
  readonly modelSelection: ModelSelection | null;
}): string | null {
  if (!input.supported) return "Update the connected T3 server to review pull requests.";
  if (!input.connected) return "Connect to the environment to review a pull request.";
  if (!input.enabled) return "Review Code is disabled in server settings.";
  if (!input.isRepo) return "This workspace is not a Git repository.";
  if (input.cwd === null) return "This thread does not have a workspace.";
  if (input.modelSelection === null) return "No model is configured for this review.";
  return null;
}

export function reviewThreadRef(environmentId: EnvironmentId, threadId: ThreadId) {
  return { environmentId, threadId };
}
