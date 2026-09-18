import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  planValidationCoordinatorRun,
  planValidationRun,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ValidationRequest,
  type ValidationTarget,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-09-17T00:00:00.000Z";
const threadId = ThreadId.make("validation-thread");
const projectId = ProjectId.make("validation-project");
const target: ValidationTarget = {
  workspaceRoot: "/workspace",
  worktreePath: "/workspace/.worktree",
  branch: "main",
  revision: "revision-1",
  dirtyStateFingerprint: "dirty-1",
  environmentIdentity: "environment-1",
};

const readModel = (
  validationRun: ReturnType<typeof planValidationRun> | null,
  validationRequest?: ValidationRequest,
): OrchestrationReadModel => ({
  snapshotSequence: 0,
  updatedAt: now,
  projects: [
    {
      id: projectId,
      title: "Validation",
      workspaceRoot: target.workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: threadId,
      projectId,
      title: "Validation",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "approval-required",
      pendingRuntimeMode: null,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: target.branch,
      worktreePath: target.worktreePath,
      ...(validationRequest === undefined ? {} : { validationRequest }),
      validationRun,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
});

const gateUpdate = (
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.validation-gate.update" }>> = {},
): Extract<OrchestrationCommand, { type: "thread.validation-gate.update" }> => ({
  type: "thread.validation-gate.update",
  commandId: CommandId.make("validation-gate-update"),
  threadId,
  runId: "run-1",
  executorId: "executor-1",
  target,
  gateId: "repository-tests",
  status: "running",
  command: "pnpm test",
  startedAt: now,
  completedAt: null,
  exitCode: null,
  outputRef: null,
  blockerReason: null,
  diagnostics: [],
  createdAt: now,
  ...overrides,
});

describe("validation executor authority", () => {
  const run = () =>
    planValidationRun({
      id: "run-1",
      threadId,
      executorId: "executor-1",
      target,
      requestedAt: now,
    });

  it("rejects a stale executor after the target changes", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: gateUpdate({
            target: { ...target, revision: "revision-2" },
          }),
          readModel: readModel(run()),
        }),
      ),
    ).rejects.toThrow("not owned by the active target executor");
  });

  it("rejects a different executor even when the run id matches", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: gateUpdate({ executorId: "other-executor" }),
          readModel: readModel(run()),
        }),
      ),
    ).rejects.toThrow("not owned by the active target executor");
  });

  it("accepts a matching executor and target", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: gateUpdate(),
        readModel: readModel(run()),
      }),
    );
    expect(result).toMatchObject({
      type: "thread.validation-gate-updated",
      payload: {
        runId: "run-1",
        gate: { id: "repository-tests", status: "running" },
      },
    });
  });

  it("records target resolution failure and clears the pending request", async () => {
    const request: ValidationRequest = {
      requestId: CommandId.make("validation:request-1"),
      threadId,
      scenarios: [],
      scope: "changed-behavior",
      requester: { id: "user-1", kind: "user" },
      requestedAt: now,
    };
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.validation.request-failed",
          commandId: CommandId.make("validation:request-1:request-failed"),
          threadId,
          failure: {
            requestId: request.requestId,
            reason: "Workspace is not a repository.",
            failedAt: now,
          },
        },
        readModel: readModel(null, request),
      }),
    );
    expect(result).toMatchObject({
      type: "thread.validation-request-failed",
      payload: {
        threadId,
        failure: { requestId: request.requestId },
      },
    });
  });

  it("allows a new request after every terminal validation run state", async () => {
    for (const status of ["ready", "failed", "blocked", "interrupted", "stale"] as const) {
      const result = await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.validation.request",
            commandId: CommandId.make(`validation:new-request-${status}`),
            threadId,
            scenarios: [],
            scope: "changed-behavior",
            requester: { id: "user-2", kind: "user" },
            requestedAt: now,
          },
          readModel: readModel({ ...run(), status }),
        }),
      );
      expect(result).toMatchObject({
        type: "thread.validation-requested",
        payload: {
          threadId,
          request: { scope: "changed-behavior" },
        },
      });
    }
  });

  it("replaces a terminal run when planning a new request", async () => {
    const request: ValidationRequest = {
      requestId: CommandId.make("validation:request-2"),
      threadId,
      scenarios: [],
      scope: "full",
      requester: { id: "user-2", kind: "user" },
      requestedAt: now,
    };
    const nextRun = planValidationCoordinatorRun({
      id: "validation:request-2",
      requestId: request.requestId,
      threadId,
      target,
      scenarios: request.scenarios,
      scope: request.scope,
      requester: request.requester,
      requestedAt: request.requestedAt,
    });
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.validation.coordinator-plan",
          commandId: CommandId.make("validation:request-2:plan"),
          threadId,
          run: nextRun,
          createdAt: now,
        },
        readModel: readModel({ ...run(), status: "ready" }, request),
      }),
    );
    expect(result).toMatchObject({
      type: "thread.validation-run-planned",
      payload: { threadId, run: { id: nextRun.id } },
    });
  });
});
