import { IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionReconciliationJob = Schema.Struct({
  sequence: NonNegativeInt,
  shellThreadIds: Schema.Array(ThreadId),
  attachmentThreadIds: Schema.Array(ThreadId),
  createdAt: IsoDateTime,
});
export type ProjectionReconciliationJob = typeof ProjectionReconciliationJob.Type;

export interface ProjectionReconciliationJobRepositoryShape {
  readonly enqueue: (
    job: ProjectionReconciliationJob,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listPending: () => Effect.Effect<
    ReadonlyArray<ProjectionReconciliationJob>,
    ProjectionRepositoryError
  >;
  readonly completeThrough: (input: {
    readonly sequence: number;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionReconciliationJobRepository extends Context.Service<
  ProjectionReconciliationJobRepository,
  ProjectionReconciliationJobRepositoryShape
>()("t3/persistence/Services/ProjectionReconciliationJobs/ProjectionReconciliationJobRepository") {}
