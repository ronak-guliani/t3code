import {
  acceptValidationResult,
  planValidationRun,
  transitionValidationGate,
  transitionValidationRunStatus,
  type ValidationStructuredResult,
  type ValidationTarget,
} from "@t3tools/contracts";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_PROVIDER_INTERACTION_MODE } from "@t3tools/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "../orchestration/decider.ts";
import {
  lifecycleCommandId,
  millisUntilNextLeaseExpiry,
  VALIDATION_LEASE_SWEEP_INTERVAL_MS,
  withValidationLeaseTimeout,
} from "../orchestration/Layers/ValidationCoordinatorReactor.ts";
import { projectEvent } from "../orchestration/projector.ts";
import type { OrchestrationReadModel } from "@t3tools/contracts";

const now = "2026-09-18T00:00:00.000Z";
const threadId = ThreadId.make("validation-thread");
const projectId = ProjectId.make("validation-project");
const target: ValidationTarget = {
  workspaceRoot: "/workspace",
  worktreePath: "/workspace/.worktree",
  branch: "main",
  revision: "rev-1",
  dirtyStateFingerprint: "dirty-1",
  environmentIdentity: "env-1",
};

const readModelWithRun = (run: ReturnType<typeof planValidationRun>): OrchestrationReadModel => ({
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
      validationRun: run,
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

const runningRun = () => {
  let run = planValidationRun({
    id: "run-1",
    threadId,
    executorId: "executor-1",
    target,
    requestedAt: now,
  });
  run = {
    ...run,
    status: "running",
    lease: {
      id: "lease:run-1",
      executorId: "executor-1",
      claimedAt: now,
      expiresAt: "2026-09-18T01:00:00.000Z",
    },
    gates: run.gates.map((gate, index) =>
      index === 0 ? { ...gate, status: "running" as const, startedAt: now } : gate,
    ),
  };
  return run;
};

const resultFor = (
  run: import("@t3tools/contracts").ValidationRun,
  overrides: Partial<ValidationStructuredResult> = {},
): ValidationStructuredResult => ({
  id: "result-1",
  runId: run.id,
  gateId: run.gates[0]!.id,
  attemptId: "attempt:run-1:gate:1",
  leaseId: "lease:run-1",
  executorId: "executor-1",
  target,
  status: "passed",
  observedAt: now,
  completedAt: "2026-09-18T00:01:00.000Z",
  exitCode: 0,
  outputRef: "artifact:lint-attempt-1:abc",
  blockerReason: null,
  diagnostics: [],
  ...overrides,
});

describe("validation coordinator integration", () => {
  it("keys repeatable lifecycle commands per cycle for engine dedup", () => {
    const first = lifecycleCommandId("run-1", "preparing", "2026-09-18T00:00:00.000Z");
    expect(lifecycleCommandId("run-1", "preparing", "2026-09-18T00:00:00.000Z")).toBe(first);
    expect(lifecycleCommandId("run-1", "preparing", "2026-09-18T00:01:00.000Z")).not.toBe(first);
    expect(lifecycleCommandId("run-1", "running", "2026-09-18T00:00:00.000Z")).not.toBe(first);
  });

  it("wakes lease-expiry sweeps from durable run state", () => {
    const base = runningRun();
    const leaseAt = (expiresAt: string) => ({
      ...base,
      requestId: "req-1",
      lease: { ...base.lease!, expiresAt },
    });
    const nowMs = Date.parse("2026-09-18T00:00:00.000Z");

    expect(millisUntilNextLeaseExpiry([], nowMs, 30_000)).toBe(30_000);
    expect(millisUntilNextLeaseExpiry([null, undefined], nowMs, 30_000)).toBe(30_000);
    expect(
      millisUntilNextLeaseExpiry(
        [{ ...leaseAt("2026-09-18T00:00:00.000Z"), requestId: undefined }],
        nowMs,
        30_000,
      ),
    ).toBe(30_000);
    expect(
      millisUntilNextLeaseExpiry(
        [{ ...leaseAt("2026-09-18T00:00:10.000Z"), lease: null }],
        nowMs,
        30_000,
      ),
    ).toBe(30_000);
    expect(millisUntilNextLeaseExpiry([leaseAt("2026-09-17T23:59:00.000Z")], nowMs, 30_000)).toBe(
      0,
    );
    expect(millisUntilNextLeaseExpiry([leaseAt("2026-09-18T00:00:10.000Z")], nowMs, 30_000)).toBe(
      10_000,
    );
    expect(
      millisUntilNextLeaseExpiry(
        [leaseAt("2026-09-18T01:00:00.000Z"), leaseAt("2026-09-18T00:00:05.000Z")],
        nowMs,
        30_000,
      ),
    ).toBe(5_000);
    expect(millisUntilNextLeaseExpiry([leaseAt("not-a-date")], nowMs, 30_000)).toBe(30_000);
    expect(VALIDATION_LEASE_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });

  it("interrupts a hung gate when its lease expires", async () => {
    let interrupted = false;
    const exit = await Effect.runPromiseExit(
      withValidationLeaseTimeout(
        Effect.never.pipe(Effect.ensuring(Effect.sync(() => void (interrupted = true)))),
        new Date(Date.now() + 20).toISOString(),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(interrupted).toBe(true);
  });

  it("does not duplicate effects for duplicate results", () => {
    const run = runningRun();
    const result = resultFor(run);
    const once = acceptValidationResult(run, result);
    expect(once.gates[0]?.attempts).toHaveLength(1);
    const twice = acceptValidationResult(once, result);
    expect(twice).toBe(once);
    expect(twice.gates[0]?.attempts).toHaveLength(1);
  });

  it("rejects expired and late results without producing readiness", () => {
    const run = runningRun();
    expect(() =>
      acceptValidationResult(run, resultFor(run, { completedAt: "2026-09-18T02:00:00.000Z" })),
    ).toThrow("after the active lease expired");
    expect(() => acceptValidationResult(run, resultFor(run, { runId: "run-old" }))).toThrow(
      "does not match the active run",
    );
    expect(() =>
      acceptValidationResult(run, resultFor(run, { target: { ...target, revision: "rev-2" } })),
    ).toThrow("does not match the planned target");
  });

  it("stops dependent work on required failure and keeps blockers actionable", () => {
    const run = runningRun();
    const failed = acceptValidationResult(run, resultFor(run, { status: "failed", exitCode: 1 }));
    expect(failed.status).toBe("failed");
    expect(() =>
      acceptValidationResult(failed, resultFor(failed, { gateId: failed.gates[1]!.id })),
    ).toThrow("while the run is failed");

    const blockedRun = runningRun();
    const blocked = acceptValidationResult(
      blockedRun,
      resultFor(blockedRun, {
        status: "blocked",
        blockerReason: "Browser is not attached. Attach a local browser tab and retry.",
      }),
    );
    expect(blocked.status).toBe("blocked");
    expect(blocked.gates[0]?.blockerReason).toContain("Attach");
  });

  it("resumes interruption without repeating completed gates", () => {
    let run = runningRun();
    run = acceptValidationResult(run, resultFor(run, { status: "passed" }));
    expect(run.gates[0]?.status).toBe("passed");
    const interruptedGate = {
      ...run.gates[1]!,
      status: "running" as const,
      startedAt: now,
    };
    let withRunning: import("@t3tools/contracts").ValidationRun = {
      ...run,
      status: "running" as const,
      gates: run.gates.map((gate) => (gate.id === interruptedGate.id ? interruptedGate : gate)),
    };
    withRunning = acceptValidationResult(
      withRunning,
      resultFor(withRunning, {
        id: "result-2",
        gateId: interruptedGate.id,
        attemptId: "attempt:2",
        status: "interrupted",
        exitCode: null,
        outputRef: null,
      }),
    );
    expect(withRunning.status).toBe("interrupted");
    expect(withRunning.gates[0]?.status).toBe("passed");
    expect(withRunning.gates[0]?.attempts).toHaveLength(1);
    const resumed = transitionValidationRunStatus(withRunning, "planned", now);
    expect(resumed.status).toBe("planned");
    expect(resumed.gates[0]?.status).toBe("passed");
  });

  it("projects gate updates and results without retargeting old runs", async () => {
    const planned = planValidationRun({
      id: "run-1",
      threadId,
      executorId: "executor-1",
      target,
      requestedAt: now,
    });
    let model = readModelWithRun({
      ...planned,
      lease: {
        id: "lease:run-1",
        executorId: "executor-1",
        claimedAt: now,
        expiresAt: "2026-09-18T01:00:00.000Z",
      },
    });
    const gateEvent = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.validation-gate.update",
          commandId: CommandId.make("cmd-1"),
          threadId,
          runId: "run-1",
          leaseId: "lease:run-1",
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
        },
        readModel: model,
      }),
    );
    const events = Array.isArray(gateEvent) ? gateEvent : [gateEvent];
    for (const event of events) {
      model = await Effect.runPromise(projectEvent(model, { ...event, sequence: 1 } as never));
    }
    expect(model.threads[0]?.validationRun?.gates[0]?.status).toBe("running");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.validation-gate.update",
            commandId: CommandId.make("cmd-2"),
            threadId,
            runId: "run-1",
            leaseId: "lease:run-1",
            executorId: "other-executor",
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
          },
          readModel: model,
        }),
      ),
    ).rejects.toThrow("not owned by the active lease and target executor");
  });

  it("ignores stale lease releases and invalid replay transitions", async () => {
    const run = runningRun();
    const model = readModelWithRun(run);
    const staleRelease = await Effect.runPromise(
      projectEvent(model, {
        type: "thread.validation-lease-released",
        sequence: 1,
        occurredAt: now,
        aggregateKind: "thread",
        aggregateId: threadId,
        commandId: "stale-release",
        payload: {
          threadId,
          runId: run.id,
          leaseId: "lease:stale",
          releasedAt: now,
        },
      } as never),
    );
    expect(staleRelease.threads[0]?.validationRun?.lease?.id).toBe(run.lease?.id);

    const invalidLifecycle = await Effect.runPromise(
      projectEvent(readModelWithRun({ ...run, status: "ready" }), {
        type: "thread.validation-lifecycle-updated",
        sequence: 2,
        occurredAt: now,
        aggregateKind: "thread",
        aggregateId: threadId,
        commandId: "invalid-lifecycle",
        payload: {
          threadId,
          update: { runId: run.id, status: "running", reason: null, updatedAt: now },
        },
      } as never),
    );
    expect(invalidLifecycle.threads[0]?.validationRun?.status).toBe("ready");

    const invalidResult = await Effect.runPromise(
      projectEvent(readModelWithRun({ ...run, status: "ready" }), {
        type: "thread.validation-result-recorded",
        sequence: 3,
        occurredAt: now,
        aggregateKind: "thread",
        aggregateId: threadId,
        commandId: "invalid-result",
        payload: {
          threadId,
          result: resultFor({ ...run, status: "ready" }),
        },
      } as never),
    );
    expect(invalidResult.threads[0]?.validationRun?.status).toBe("ready");
  });

  it("accepts interrupted-to-pending gate resets so resumed runs stay schedulable", async () => {
    const running = runningRun();
    const gateId = running.gates[0]!.id;
    const interrupted = transitionValidationGate(
      running,
      {
        gateId,
        status: "interrupted",
        command: "pnpm test",
        startedAt: now,
        completedAt: now,
        exitCode: null,
        outputRef: null,
        blockerReason: null,
        diagnostics: ["Reactor restarted while gate was running."],
      },
      now,
    );
    expect(interrupted.gates[0]?.status).toBe("interrupted");

    let model = readModelWithRun(interrupted);
    const reset = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.validation-gate.update",
          commandId: CommandId.make("cmd-reset-1"),
          threadId,
          runId: "run-1",
          leaseId: "lease:run-1",
          executorId: "executor-1",
          target,
          gateId,
          status: "pending",
          command: "pnpm test",
          startedAt: null,
          completedAt: null,
          exitCode: null,
          outputRef: null,
          blockerReason: null,
          diagnostics: ["Gate reset to pending after the run was interrupted."],
          createdAt: now,
        },
        readModel: model,
      }),
    );
    const events = Array.isArray(reset) ? reset : [reset];
    for (const event of events) {
      model = await Effect.runPromise(projectEvent(model, { ...event, sequence: 1 } as never));
    }
    expect(model.threads[0]?.validationRun?.gates[0]?.status).toBe("pending");
  });

  it("drives the run to blocked when a gate kind has no runner", async () => {
    const run = runningRun();
    const gateId = run.gates[0]!.id;
    let model = readModelWithRun(run);
    const record = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.validation.result.record",
          commandId: CommandId.make("cmd-result-unknown-1"),
          threadId,
          result: resultFor(run, {
            id: `result:run-1:${gateId}:attempt:run-1:${gateId}:1`,
            attemptId: `attempt:run-1:${gateId}:1`,
            status: "blocked",
            exitCode: null,
            outputRef: null,
            blockerReason: "Gate kind repository-tests has no integrated runner.",
            diagnostics: ["Select a supported validation gate."],
          }),
        },
        readModel: model,
      }),
    );
    const events = Array.isArray(record) ? record : [record];
    for (const event of events) {
      model = await Effect.runPromise(projectEvent(model, { ...event, sequence: 1 } as never));
    }
    expect(model.threads[0]?.validationRun?.status).toBe("blocked");
    expect(model.threads[0]?.validationRun?.gates[0]?.status).toBe("blocked");
    expect(model.threads[0]?.validationRun?.gates[0]?.blockerReason).toContain(
      "no integrated runner",
    );
  });

  it("maps failure taxonomy to typed outcomes", () => {
    const run = runningRun();
    const cases: Array<{
      status: "passed" | "failed" | "blocked" | "interrupted";
      reason: string;
    }> = [
      { status: "failed", reason: "nonzero-exit" },
      { status: "blocked", reason: "invalid-spec" },
      { status: "blocked", reason: "missing web build" },
      { status: "blocked", reason: "invalid MCP credential" },
      { status: "blocked", reason: "unsupported browser" },
      { status: "blocked", reason: "environment mismatch" },
      { status: "failed", reason: "evidence corruption" },
      { status: "interrupted", reason: "cancelled" },
    ];
    for (const { status } of cases) {
      const accepted = acceptValidationResult(
        runningRun(),
        resultFor(run, {
          id: `r-${status}-${Math.random()}`,
          attemptId: `a-${status}-${Math.random()}`,
          status,
        }),
      );
      expect(accepted.gates[0]?.status).toBe(status);
    }
    expect(run.target.revision).toBe("rev-1");
  });

  it("requires running gate before pass/fail/interrupt", () => {
    const planned = planValidationRun({
      id: "run-1",
      threadId,
      executorId: "executor-1",
      target,
      requestedAt: now,
    });
    expect(() =>
      transitionValidationGate(
        planned,
        {
          gateId: "repository-tests",
          status: "failed",
          command: "pnpm test",
          startedAt: null,
          completedAt: now,
          exitCode: 1,
          outputRef: null,
          blockerReason: null,
          diagnostics: [],
        },
        now,
      ),
    ).toThrow();
  });
});
