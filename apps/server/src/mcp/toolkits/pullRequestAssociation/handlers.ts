import { randomUUID } from "node:crypto";

import { CommandId, type GitPullRequestAssociation, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { GitManager } from "../../../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PullRequestAssociationError, PullRequestAssociationToolkit } from "./tools.ts";

const associationError = (message: string, cause?: unknown) =>
  new PullRequestAssociationError({ message, ...(cause === undefined ? {} : { cause }) });

/**
 * The authenticated caller. `threadId` comes from the MCP credential the server minted for
 * this provider session, so a tool argument can never impersonate another chat. The checkout
 * mirrors the thread's bound worktree (falling back to the project root), matching the
 * `t3 chat associate-pr --cwd` behavior without trusting agent-supplied paths.
 */
const requireCaller = Effect.fn("PullRequestAssociationToolkit.requireCaller")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const projections = yield* ProjectionSnapshotQuery;
  const shell = yield* projections
    .getThreadShellById(invocation.threadId)
    .pipe(
      Effect.mapError((cause) => associationError("Could not resolve the calling chat.", cause)),
    );
  if (Option.isNone(shell)) {
    return yield* associationError("The calling chat no longer exists.");
  }
  const checkpoint = yield* projections
    .getThreadCheckpointContext(invocation.threadId)
    .pipe(
      Effect.mapError((cause) =>
        associationError("Could not resolve the calling chat workspace.", cause),
      ),
    );
  if (Option.isNone(checkpoint)) {
    return yield* associationError("The calling chat workspace is unavailable.");
  }
  return {
    threadId: invocation.threadId as ThreadId,
    cwd: checkpoint.value.worktreePath ?? checkpoint.value.workspaceRoot,
    shell: shell.value,
  };
});

const resolveReference = (input: { readonly cwd: string; readonly reference: string }) =>
  Effect.gen(function* () {
    const reference = input.reference.trim();
    if (reference.length === 0) {
      return yield* associationError("A pull request URL or number is required.");
    }
    const git = yield* GitManager;
    const resolved = yield* git
      .resolvePullRequest({ cwd: input.cwd, reference })
      .pipe(
        Effect.mapError((cause) =>
          associationError(`Could not resolve pull request "${reference}".`, cause),
        ),
      );
    return resolved.pullRequest as GitPullRequestAssociation;
  });

export const PullRequestAssociationToolkitHandlersLive = PullRequestAssociationToolkit.toLayer({
  associate_pull_request: (input) =>
    Effect.gen(function* () {
      const caller = yield* requireCaller();
      const pullRequest = yield* resolveReference({ cwd: caller.cwd, reference: input.reference });
      const engine = yield* OrchestrationEngineService;
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(randomUUID()),
          threadId: caller.threadId,
          pullRequest,
          pullRequestOwnership: "transfer",
        })
        .pipe(
          Effect.mapError((cause) =>
            associationError("Could not associate the pull request with this chat.", cause),
          ),
        );
      yield* engine
        .dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(randomUUID()),
          threadId: caller.threadId,
          pullRequest,
          source: "agent",
        })
        .pipe(
          Effect.mapError((cause) =>
            associationError("Could not link the pull request to this chat.", cause),
          ),
        );
      return { pullRequest };
    }),

  link_pull_request: (input) =>
    Effect.gen(function* () {
      const caller = yield* requireCaller();
      const pullRequest = yield* resolveReference({ cwd: caller.cwd, reference: input.reference });
      const engine = yield* OrchestrationEngineService;
      yield* engine
        .dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(randomUUID()),
          threadId: caller.threadId,
          pullRequest,
          source: "manual",
        })
        .pipe(
          Effect.mapError((cause) =>
            associationError("Could not link the pull request to this chat.", cause),
          ),
        );
      return { pullRequest };
    }),

  unlink_pull_request: (input) =>
    Effect.gen(function* () {
      const caller = yield* requireCaller();
      const pullRequest = yield* resolveReference({ cwd: caller.cwd, reference: input.reference });
      const engine = yield* OrchestrationEngineService;
      yield* engine
        .dispatch({
          type: "thread.pull-request.unlink",
          commandId: CommandId.make(randomUUID()),
          threadId: caller.threadId,
          pullRequest,
        })
        .pipe(
          Effect.mapError((cause) =>
            associationError("Could not unlink the pull request from this chat.", cause),
          ),
        );
      return { pullRequest };
    }),

  list_thread_pull_requests: () =>
    Effect.gen(function* () {
      const caller = yield* requireCaller();
      const linked = caller.shell.pullRequests ?? [];
      if (linked.length > 0) return { pullRequests: [...linked] };
      const fallback = caller.shell.pullRequest;
      if (!fallback) return { pullRequests: [] };
      return {
        pullRequests: [
          { pullRequest: fallback, source: "manual" as const, linkedAt: caller.shell.updatedAt },
        ],
      };
    }),
});
