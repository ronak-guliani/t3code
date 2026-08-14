import {
  PullRequestMonitorError,
  type ProjectId,
  type PullRequestMonitorRecord,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PullRequestMonitorService } from "../../../pullRequestMonitor/PullRequestMonitorService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PullRequestMonitorToolkit } from "./tools.ts";

const monitorError = (message: string, cause?: unknown) =>
  new PullRequestMonitorError({ message, ...(cause === undefined ? {} : { cause }) });

/**
 * The authenticated caller. `threadId` comes from the MCP credential the server minted for
 * this provider session, so a tool argument can never impersonate another chat.
 */
const requireCaller = Effect.fn("PullRequestMonitorToolkit.requireCaller")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const projections = yield* ProjectionSnapshotQuery;
  const shell = yield* projections
    .getThreadShellById(invocation.threadId)
    .pipe(Effect.mapError((cause) => monitorError("Could not resolve the calling chat.", cause)));
  if (Option.isNone(shell)) {
    return yield* monitorError("The calling chat no longer exists.");
  }
  return {
    threadId: invocation.threadId as ThreadId,
    projectId: shell.value.projectId as ProjectId,
  };
});

const resolveSelector = (input: {
  readonly monitorId?: string | undefined;
  readonly repository?: string | undefined;
  readonly number?: number | undefined;
  readonly projectId: ProjectId;
}) => ({
  ...(input.monitorId === undefined
    ? {}
    : { monitorId: input.monitorId as PullRequestMonitorRecord["id"] }),
  ...(input.repository !== undefined && input.number !== undefined
    ? {
        reference: {
          projectId: input.projectId,
          repository: input.repository,
          number: input.number,
        },
      }
    : {}),
});

/**
 * A chat may only touch a monitor it is involved with: its owner or its linked review chat.
 * Project membership alone is not enough, or one chat could disposition another's findings.
 */
const requireMonitorAccess = (input: {
  readonly monitor: PullRequestMonitorRecord | null;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}) =>
  Effect.gen(function* () {
    const monitor = input.monitor;
    if (!monitor) return yield* monitorError("No pull request monitor matched this request.");
    if (monitor.projectId !== input.projectId) {
      return yield* monitorError("This monitor belongs to another project.");
    }
    if (
      monitor.ownerThreadId !== input.threadId &&
      monitor.linkedReviewThreadId !== input.threadId
    ) {
      return yield* monitorError(
        "This chat is not the owner or linked review chat for that monitor.",
      );
    }
    return monitor;
  });

export const PullRequestMonitorToolkitHandlersLive = PullRequestMonitorToolkit.toLayer({
  pr_monitor_context: (input) =>
    Effect.gen(function* () {
      const caller = yield* requireCaller();
      const monitors = yield* PullRequestMonitorService;
      const result = yield* monitors.context({
        ...resolveSelector({ ...input, projectId: caller.projectId }),
        ...(input.includeClosed === undefined ? {} : { includeClosed: input.includeClosed }),
      });
      yield* requireMonitorAccess({
        monitor: result.monitor,
        threadId: caller.threadId,
        projectId: caller.projectId,
      });
      return result;
    }),

  pr_monitor_report: (input) =>
    Effect.gen(function* () {
      const caller = yield* requireCaller();
      const monitors = yield* PullRequestMonitorService;
      const selector = resolveSelector({ ...input, projectId: caller.projectId });
      const context = yield* monitors.context(selector);
      yield* requireMonitorAccess({
        monitor: context.monitor,
        threadId: caller.threadId,
        projectId: caller.projectId,
      });
      return yield* monitors.report({
        ...selector,
        itemId: input.itemId,
        disposition: input.disposition,
        ...(input.note === undefined ? {} : { note: input.note }),
        // Server-derived: the reporter is whoever holds this credential.
        reporterThreadId: caller.threadId,
      });
    }),

  pr_monitor_submit_findings: (input) =>
    Effect.gen(function* () {
      const caller = yield* requireCaller();
      const monitors = yield* PullRequestMonitorService;
      return yield* monitors.submitFindings({
        reference: {
          projectId: caller.projectId,
          repository: input.repository,
          number: input.number,
        },
        // The review chat is the authenticated caller, never an argument.
        reviewThreadId: caller.threadId,
        findings: input.findings,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.startMonitoring === undefined ? {} : { startMonitoring: input.startMonitoring }),
      });
    }),
});
