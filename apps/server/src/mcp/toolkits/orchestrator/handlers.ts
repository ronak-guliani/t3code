import { PullRequestMonitorError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../OrchestratorMcpService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { PullRequestMonitorService } from "../../../pullRequestMonitor/PullRequestMonitorService.ts";
import { OrchestratorToolkit } from "./tools.ts";

const invokerProjectId = Effect.gen(function* () {
  const scope = yield* McpInvocationContext;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projection = yield* threads.getThreadProjection(scope.threadId).pipe(
    Effect.mapError(
      (cause) =>
        new PullRequestMonitorError({
          message: "Could not resolve invoking thread project scope.",
          cause,
        }),
    ),
  );
  return projection.thread.projectId;
});

const assertMonitorInInvokerProject = Effect.fn("mcp.assertMonitorInInvokerProject")(function* (
  monitorProjectId: string | null | undefined,
) {
  if (monitorProjectId == null) return;
  const projectId = yield* invokerProjectId;
  if (projectId !== monitorProjectId) {
    return yield* new PullRequestMonitorError({
      message: "PR monitor is outside this thread project scope.",
    });
  }
});

const handlers = {
  orchestrator_capabilities: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.capabilities(scope);
    }),
  delegate_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.delegateTask(scope, input);
    }),
  task_status: ({ taskId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.taskStatus(scope, taskId);
    }),
  task_cancel: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.cancelTask(scope, input);
    }),
  schedule_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.scheduleTask(scope, input);
    }),
  list_scheduled_tasks: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.listScheduledTasks(scope);
    }),
  update_scheduled_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.updateScheduledTask(scope, input);
    }),
  delete_scheduled_task: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.deleteScheduledTask(scope, input);
    }),
  create_threads: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.createThreads(scope, input);
    }),
  t3_thread_start: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      const result = yield* service.createThreads(scope, {
        ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
        threads: [
          {
            prompt: input.prompt,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.target === undefined ? {} : { target: input.target }),
            ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
            ...(input.interactionMode === undefined
              ? {}
              : { interactionMode: input.interactionMode }),
          },
        ],
      });
      return result.threads[0]!;
    }),
  t3_thread_list: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.listThreads(scope, input);
    }),
  t3_thread_read: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.readThread(scope, input);
    }),
  t3_thread_send: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.sendToThread(scope, input);
    }),
  t3_thread_wait: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.waitForThread(scope, input);
    }),
  t3_thread_interrupt: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* OrchestratorMcpService;
      return yield* service.interruptThread(scope, input);
    }),
  t3_pr_monitor_context: (input) =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const projectId = yield* invokerProjectId;
      const result = yield* monitors.context(input);
      if (result.monitor !== null && result.monitor.projectId !== projectId) {
        return {
          monitor: null,
          latestSnapshot: null,
          items: [],
          recentDeliveries: [],
          recentReports: [],
        };
      }
      return result;
    }),
  t3_pr_monitor_report: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const monitors = yield* PullRequestMonitorService;
      const status = yield* monitors.status({
        ...(input.monitorId === undefined ? {} : { monitorId: input.monitorId }),
        ...(input.reference === undefined ? {} : { reference: input.reference }),
      });
      yield* assertMonitorInInvokerProject(status.monitor?.projectId);
      return yield* monitors.report({
        ...input,
        reporterThreadId: input.reporterThreadId ?? scope.threadId,
      });
    }),
  t3_pr_monitor_submit_findings: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const monitors = yield* PullRequestMonitorService;
      return yield* monitors.submitFindings({
        ...input,
        reviewThreadId: input.reviewThreadId ?? scope.threadId,
      });
    }),
} satisfies Parameters<typeof OrchestratorToolkit.toLayer>[0];

export const OrchestratorToolkitHandlersLive = OrchestratorToolkit.toLayer(handlers);
