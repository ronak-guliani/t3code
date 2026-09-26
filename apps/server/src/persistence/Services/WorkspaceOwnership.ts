import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import { ThreadId, WorkspaceBinding } from "@t3tools/contracts";

export const WorkspaceOwnership = Schema.Struct({
  canonicalPath: Schema.String,
  worktreePath: Schema.String,
  ownerThreadId: ThreadId,
  branch: Schema.NullOr(Schema.String),
  generation: Schema.Number,
  commandId: Schema.NullOr(Schema.String),
  claimedAt: Schema.String,
  updatedAt: Schema.String,
});
export type WorkspaceOwnership = typeof WorkspaceOwnership.Type;

export class WorkspaceOwnershipConflict extends Data.TaggedError("WorkspaceOwnershipConflict")<{
  readonly canonicalPath: string;
  readonly ownerThreadId: string;
  readonly requestedByThreadId: string;
}> {}

export class WorkspaceOwnershipStale extends Data.TaggedError("WorkspaceOwnershipStale")<{
  readonly binding: WorkspaceBinding;
  readonly requestedByThreadId: string;
}> {}

export class WorkspaceOwnershipRepositoryError extends Data.TaggedError(
  "WorkspaceOwnershipRepositoryError",
)<{
  readonly cause: unknown;
}> {}

export interface WorkspaceOwnershipRepositoryShape {
  readonly claim: (input: {
    readonly threadId: ThreadId;
    readonly worktreePath: string;
    readonly branch: string | null;
    readonly commandId: string | null;
    readonly now: string;
  }) => Effect.Effect<
    WorkspaceBinding,
    WorkspaceOwnershipConflict | WorkspaceOwnershipRepositoryError
  >;
  readonly assertOwned: (
    binding: WorkspaceBinding,
    threadId: ThreadId,
  ) => Effect.Effect<void, WorkspaceOwnershipStale | WorkspaceOwnershipRepositoryError>;
  readonly release: (
    threadId: ThreadId,
    canonicalPath?: string,
  ) => Effect.Effect<void, WorkspaceOwnershipRepositoryError>;
  readonly getByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<WorkspaceOwnership>, WorkspaceOwnershipRepositoryError>;
}

export class WorkspaceOwnershipRepository extends Context.Service<
  WorkspaceOwnershipRepository,
  WorkspaceOwnershipRepositoryShape
>()("t3/persistence/Services/WorkspaceOwnership/WorkspaceOwnershipRepository") {}
