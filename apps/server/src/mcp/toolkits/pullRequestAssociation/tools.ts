import { GitPullRequestAssociation, ThreadPullRequestLink } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { GitManager } from "../../../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
  GitManager,
  OrchestrationEngineService,
];

export class PullRequestAssociationError extends Schema.TaggedErrorClass<PullRequestAssociationError>()(
  "PullRequestAssociationError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Pull request reference, mirroring the `t3-tools` adapter: URL or number,
 * resolved through GitHub in the calling thread's checkout.
 */
const PullRequestReferenceInput = Schema.Struct({
  reference: Schema.String,
});

export const PullRequestAssociationResult = Schema.Struct({
  pullRequest: GitPullRequestAssociation,
});
export type PullRequestAssociationResult = typeof PullRequestAssociationResult.Type;

export const ThreadPullRequestListResult = Schema.Struct({
  pullRequests: Schema.Array(ThreadPullRequestLink),
});
export type ThreadPullRequestListResult = typeof ThreadPullRequestListResult.Type;

export const AssociatePullRequestTool = Tool.make("associate_pull_request", {
  description:
    "Durably associate a pull request with the calling T3 thread. Call this after successfully creating or explicitly opening a PR for this thread. The URL or number is resolved through GitHub and persisted on the thread; never infer association from the current branch.",
  parameters: PullRequestReferenceInput,
  success: PullRequestAssociationResult,
  failure: PullRequestAssociationError,
  dependencies,
})
  .annotate(Tool.Title, "Associate pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const LinkPullRequestTool = Tool.make("link_pull_request", {
  description:
    "Link a pull request to the calling T3 thread without changing its workspace pull request. The operation is idempotent.",
  parameters: PullRequestReferenceInput,
  success: PullRequestAssociationResult,
  failure: PullRequestAssociationError,
  dependencies,
})
  .annotate(Tool.Title, "Link pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const UnlinkPullRequestTool = Tool.make("unlink_pull_request", {
  description: "Unlink a pull request from the calling T3 thread. The operation is idempotent.",
  parameters: PullRequestReferenceInput,
  success: PullRequestAssociationResult,
  failure: PullRequestAssociationError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ListThreadPullRequestsTool = Tool.make("list_thread_pull_requests", {
  description: "List all pull requests linked to the calling T3 thread.",
  // Object-only no-argument schema: Struct({}) exports an object/array union.
  parameters: Schema.Record(Schema.String, Schema.Never),
  success: ThreadPullRequestListResult,
  failure: PullRequestAssociationError,
  dependencies,
})
  .annotate(Tool.Title, "List thread pull requests")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const PullRequestAssociationToolkit = Toolkit.make(
  AssociatePullRequestTool,
  LinkPullRequestTool,
  UnlinkPullRequestTool,
  ListThreadPullRequestsTool,
);
