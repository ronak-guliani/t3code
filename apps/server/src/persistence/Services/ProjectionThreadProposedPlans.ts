import {
  IsoDateTime,
  OrchestrationProposedPlanId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import { Schema, Context } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadProposedPlan = Schema.Struct({
  planId: OrchestrationProposedPlanId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime),
  implementationThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadProposedPlan = typeof ProjectionThreadProposedPlan.Type;

export const ListProjectionThreadProposedPlansInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadProposedPlansInput =
  typeof ListProjectionThreadProposedPlansInput.Type;

export const DeleteProjectionThreadProposedPlansInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadProposedPlansInput =
  typeof DeleteProjectionThreadProposedPlansInput.Type;

export const DeleteTrimmedProjectionThreadProposedPlansInput = Schema.Struct({
  threadId: ThreadId,
  retainedTurnIds: Schema.Array(TurnId),
});
export type DeleteTrimmedProjectionThreadProposedPlansInput =
  typeof DeleteTrimmedProjectionThreadProposedPlansInput.Type;

/**
 * Summary fields of a proposed plan: everything the shell summary needs
 * without the (potentially large) plan markdown.
 */
export const ProjectionThreadProposedPlanSummary = Schema.Struct({
  planId: OrchestrationProposedPlanId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  implementedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadProposedPlanSummary = typeof ProjectionThreadProposedPlanSummary.Type;

export interface ProjectionThreadProposedPlanRepositoryShape {
  readonly upsert: (
    proposedPlan: ProjectionThreadProposedPlan,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadProposedPlansInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadProposedPlan>, ProjectionRepositoryError>;
  /**
   * List proposed-plan summaries for a thread, omitting plan markdown.
   *
   * Returned in ascending creation order.
   */
  readonly listSummariesByThreadId: (
    input: ListProjectionThreadProposedPlansInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadProposedPlanSummary>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadProposedPlansInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /**
   * Delete only proposed plans of turns outside `retainedTurnIds`.
   *
   * Turn-less plans are always kept. Unlike `deleteByThreadId` +
   * re-upserting kept rows, this never reads plan markdown and never rewrites
   * retained rows. An empty `retainedTurnIds` list deletes every plan attached
   * to a turn.
   */
  readonly deleteTrimmedByThreadId: (
    input: DeleteTrimmedProjectionThreadProposedPlansInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadProposedPlanRepository extends Context.Service<
  ProjectionThreadProposedPlanRepository,
  ProjectionThreadProposedPlanRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadProposedPlans/ProjectionThreadProposedPlanRepository",
) {}
