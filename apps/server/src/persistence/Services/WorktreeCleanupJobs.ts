import { Context, Schema } from "effect";
import type { Effect } from "effect";
import { IsoDateTime, ThreadId } from "@t3tools/contracts";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const WorktreeCleanupJob = Schema.Struct({
  threadId: ThreadId,
  cwd: Schema.String,
  worktreePath: Schema.String,
  requestedAt: IsoDateTime,
});
export type WorktreeCleanupJob = typeof WorktreeCleanupJob.Type;

export interface WorktreeCleanupJobRepositoryShape {
  readonly upsert: (job: WorktreeCleanupJob) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly list: () => Effect.Effect<ReadonlyArray<WorktreeCleanupJob>, ProjectionRepositoryError>;
  readonly existsByPath: (
    worktreePath: string,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly cancelByThreadId: (threadId: ThreadId) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (threadId: ThreadId) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class WorktreeCleanupJobRepository extends Context.Service<
  WorktreeCleanupJobRepository,
  WorktreeCleanupJobRepositoryShape
>()("t3/persistence/Services/WorktreeCleanupJobs/WorktreeCleanupJobRepository") {}
