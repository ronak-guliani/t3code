import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  planValidationRun,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
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
  validationRun: ReturnType<typeof planValidationRun>,
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
});
