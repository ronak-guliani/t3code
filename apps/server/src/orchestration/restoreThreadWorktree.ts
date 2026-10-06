import type { ThreadId } from "@t3tools/contracts";
import { Cause, Effect } from "effect";

import type { CheckoutCoordinator } from "../git/CheckoutCoordinator.ts";
import type { GitCore } from "../git/Services/GitCore.ts";
import type { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";

export interface RestoreThreadWorktreeInput {
  readonly threadId: ThreadId;
  readonly projectId: string;
  readonly projectCwd: string;
  readonly worktreePath: string;
  readonly branch: string;
}

export interface RestoreThreadWorktreeDependencies {
  readonly git: GitCore["Service"];
  readonly checkoutCoordinator: CheckoutCoordinator["Service"];
  readonly projectSetupScriptRunner: ProjectSetupScriptRunner["Service"];
}

/** Recreate a reclaimed checkout on its existing branch/path, then launch setup. */
export function restoreThreadWorktree(
  dependencies: RestoreThreadWorktreeDependencies,
  input: RestoreThreadWorktreeInput,
): Effect.Effect<void, Error> {
  const restore = dependencies.checkoutCoordinator.withCheckout(
    input.projectCwd,
    dependencies.git.pruneWorktrees(input.projectCwd).pipe(
      Effect.andThen(
        dependencies.git.createWorktree({
          cwd: input.projectCwd,
          branch: input.branch,
          path: input.worktreePath,
        }),
      ),
    ),
  );

  return restore.pipe(
    Effect.mapError((cause) => {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return new Error(
        `Could not restore worktree '${input.worktreePath}' for thread '${input.threadId}' on branch '${input.branch}'. Ensure the branch exists locally and is not checked out in another worktree, then retry. Git reported: ${detail}`,
        { cause },
      );
    }),
    Effect.flatMap(() =>
      dependencies.projectSetupScriptRunner
        .runForThread({
          threadId: input.threadId,
          projectId: input.projectId,
          projectCwd: input.projectCwd,
          worktreePath: input.worktreePath,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("setup script failed after restoring worktree", {
              threadId: input.threadId,
              worktreePath: input.worktreePath,
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.forkDetach,
          Effect.asVoid,
        ),
    ),
    Effect.asVoid,
  );
}
