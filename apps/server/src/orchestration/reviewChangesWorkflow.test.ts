import {
  AgentWorkflowSettings,
  GitCommandError,
  type GitResolveReviewChangesContextResult,
  type OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkflowRunError,
  type WorkflowRunInput,
} from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { GitCore } from "../git/Services/GitCore.ts";
import { runReviewChangesWorkflow } from "./reviewChangesWorkflow.ts";
import type { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import type { ServerSettingsService } from "../serverSettings.ts";

const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");

function makeSnapshot(diffHash: string) {
  return {
    scope: { kind: "uncommitted", branch: "main", untrackedFiles: [] },
    diff: "diff --git a/src/a.ts b/src/a.ts\n",
    diffHash,
  } as const;
}

function makeReviewContext(diffHash: string) {
  return {
    scope: "uncommitted",
    branch: "main",
    statusShort: "",
    untrackedFiles: [],
    hasReviewableChanges: true,
    snapshot: makeSnapshot(diffHash),
  } as const;
}

const decodeAgentWorkflowSettings = Schema.decodeUnknownSync(AgentWorkflowSettings);

interface WorkflowHarness {
  readonly dispatched: OrchestrationCommand[];
  readonly order: string[];
  readonly run: (input: WorkflowRunInput) => Effect.Effect<unknown, WorkflowRunError>;
}

function createHarness(options: {
  readonly claim: () => Effect.Effect<GitResolveReviewChangesContextResult, GitCommandError>;
}): WorkflowHarness {
  const dispatched: OrchestrationCommand[] = [];
  const order: string[] = [];
  const git = {
    claimReviewChangesContext: () => {
      order.push("claim");
      return options.claim();
    },
  } as unknown as GitCore["Service"];
  const orchestrationEngine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        order.push("dispatch");
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
    getReadModel: () => Effect.die(new Error("getReadModel should not be called in this test")),
  } as unknown as OrchestrationEngineService["Service"];
  const threadShell = {
    id: threadId,
    projectId,
    worktreePath: null,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
  };
  const projectShell = {
    id: projectId,
    workspaceRoot: "/tmp/t3-review-workflow-test",
  };
  const projectionSnapshotQuery = {
    getThreadShellById: () => Effect.succeed(Option.some(threadShell)),
    getProjectShellById: () => Effect.succeed(Option.some(projectShell)),
  } as unknown as ProjectionSnapshotQuery["Service"];
  const serverSettings = {
    getSettings: Effect.succeed({
      agentWorkflows: decodeAgentWorkflowSettings({}),
    }),
  } as unknown as ServerSettingsService["Service"];
  return {
    dispatched,
    order,
    run: (input) =>
      runReviewChangesWorkflow(
        {
          git,
          orchestrationEngine,
          projectionSnapshotQuery,
          serverSettings,
          workflowCoordinator: Option.none(),
        },
        input,
      ),
  };
}

function makeInput(idempotencyKey: string): WorkflowRunInput {
  return {
    workflowId: "review-changes",
    threadId,
    projectId,
    cwd: "/tmp/t3-review-workflow-test",
    input: { scope: "uncommitted" },
    destinationMode: "child-chat",
    trigger: "manual",
    idempotencyKey,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
  };
}

describe("runReviewChangesWorkflow review snapshot binding", () => {
  it("captures a fresh snapshot before starting the review and binds it to the worker turn", async () => {
    const harness = createHarness({
      claim: () => Effect.succeed(makeReviewContext("hash-a")),
    });
    const result = await Effect.runPromise(harness.run(makeInput("run-1")));
    expect(harness.order[0]).toBe("claim");
    expect(harness.order).toContain("dispatch");
    expect(result).toMatchObject({ status: "started" });
    const request = harness.dispatched.find((command) => command.type === "workflow.run.request");
    expect(request).toMatchObject({
      type: "workflow.run.request",
      workerConfig: { reviewSnapshot: makeSnapshot("hash-a") },
    });
  });

  it("binds each re-review to its own fresh snapshot revision", async () => {
    let calls = 0;
    const harness = createHarness({
      claim: () => {
        calls += 1;
        return Effect.succeed(makeReviewContext(calls === 1 ? "hash-a" : "hash-b"));
      },
    });
    await Effect.runPromise(harness.run(makeInput("run-1")));
    await Effect.runPromise(harness.run(makeInput("run-2")));
    const requests = harness.dispatched.filter(
      (command) => command.type === "workflow.run.request",
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      workerConfig: { reviewSnapshot: makeSnapshot("hash-a") },
    });
    expect(requests[1]).toMatchObject({
      workerConfig: { reviewSnapshot: makeSnapshot("hash-b") },
    });
  });

  it("fails explicitly without starting a review when snapshot capture fails", async () => {
    const harness = createHarness({
      claim: () =>
        Effect.fail(
          new GitCommandError({
            operation: "test",
            command: "gh pr diff",
            cwd: "test",
            detail: "GitHub unavailable",
          }),
        ),
    });
    await expect(Effect.runPromise(harness.run(makeInput("run-1")))).rejects.toThrow(
      /GitHub unavailable/,
    );
    expect(harness.dispatched).toHaveLength(0);
  });
});
