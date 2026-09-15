import {
  GitPullRequestAssociation,
  IsoDateTime,
  ThreadId,
  ThreadPullRequestLinkSource,
} from "@t3tools/contracts";
import { Context, Effect, Schema } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadPullRequest = Schema.Struct({
  threadId: ThreadId,
  pullRequest: GitPullRequestAssociation,
  source: ThreadPullRequestLinkSource,
  linkedAt: IsoDateTime,
});
export type ProjectionThreadPullRequest = typeof ProjectionThreadPullRequest.Type;

export interface ProjectionThreadPullRequestRepositoryShape {
  readonly upsert: (
    row: ProjectionThreadPullRequest,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<ReadonlyArray<ProjectionThreadPullRequest>, ProjectionRepositoryError>;
  readonly listByPullRequest: (input: {
    readonly pullRequest: GitPullRequestAssociation;
  }) => Effect.Effect<ReadonlyArray<ProjectionThreadPullRequest>, ProjectionRepositoryError>;
  readonly delete: (input: {
    readonly threadId: ThreadId;
    readonly pullRequest: GitPullRequestAssociation;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadPullRequestRepository extends Context.Service<
  ProjectionThreadPullRequestRepository,
  ProjectionThreadPullRequestRepositoryShape
>()("t3/persistence/Services/ProjectionThreadPullRequests/ProjectionThreadPullRequestRepository") {}

export const ProjectionThreadPullRequestDbRow = Schema.Struct({
  threadId: ThreadId,
  pullRequest: Schema.fromJsonString(GitPullRequestAssociation),
  source: ThreadPullRequestLinkSource,
  linkedAt: IsoDateTime,
});
export type ProjectionThreadPullRequestDbRow = typeof ProjectionThreadPullRequestDbRow.Type;
