import { describe, expect, it } from "vitest";

import {
  acceptValidationResult,
  planValidationCoordinatorRun,
  planValidationRun,
  reduceValidationReadiness,
  transitionValidationRunStatus,
  transitionValidationGate,
  validationRunEquals,
  validationTargetEquals,
  type ValidationTarget,
} from "./validation.ts";

const target: ValidationTarget = {
  workspaceRoot: "/workspace",
  worktreePath: "/workspace/.worktree",
  branch: "feat/validation",
  revision: "abc123",
  dirtyStateFingerprint: "dirty-1",
  environmentIdentity: "env-1",
};

const run = () =>
  planValidationRun({
    id: "run-1",
    threadId: "thread-1" as never,
    target,
    requestedAt: "2026-09-16T12:00:00.000Z",
  });

describe("validation runs", () => {
  it("keeps never-started self-test optional and readiness blocked by required gates", () => {
    const planned = run();
    expect(planned.gates.find((gate) => gate.id === "self-test")?.status).toBe("not-required");
    expect(reduceValidationReadiness(planned, target)).toBe("not-ready");
  });

  it("requires a running gate before it can pass, fail, or interrupt", () => {
    const planned = run();
    expect(() =>
      transitionValidationGate(
        planned,
        {
          gateId: "repository-tests",
          status: "failed",
          command: "pnpm test",
          startedAt: null,
          completedAt: "2026-09-16T12:01:00.000Z",
          exitCode: 1,
          outputRef: null,
          blockerReason: null,
          diagnostics: [],
        },
        "2026-09-16T12:01:00.000Z",
      ),
    ).toThrow();
  });

  it("keeps repository and browser outcomes independent", () => {
    let current = run();
    current = transitionValidationGate(
      current,
      {
        gateId: "repository-tests",
        status: "running",
        command: "pnpm test",
        startedAt: "2026-09-16T12:01:00.000Z",
        completedAt: null,
        exitCode: null,
        outputRef: null,
        blockerReason: null,
        diagnostics: [],
      },
      "2026-09-16T12:01:00.000Z",
    );
    current = transitionValidationGate(
      current,
      {
        gateId: "repository-tests",
        status: "passed",
        command: "pnpm test",
        startedAt: "2026-09-16T12:01:00.000Z",
        completedAt: "2026-09-16T12:10:00.000Z",
        exitCode: 0,
        outputRef: "output://tests",
        blockerReason: null,
        diagnostics: [],
      },
      "2026-09-16T12:10:00.000Z",
    );
    current = transitionValidationGate(
      current,
      {
        gateId: "browser-validation",
        status: "running",
        command: "real-client browser validation",
        startedAt: "2026-09-16T12:11:00.000Z",
        completedAt: null,
        exitCode: null,
        outputRef: null,
        blockerReason: null,
        diagnostics: [],
      },
      "2026-09-16T12:11:00.000Z",
    );
    current = transitionValidationGate(
      current,
      {
        gateId: "browser-validation",
        status: "blocked",
        command: "real-client browser validation",
        startedAt: "2026-09-16T12:11:00.000Z",
        completedAt: "2026-09-16T12:12:00.000Z",
        exitCode: null,
        outputRef: null,
        blockerReason: "Browser is not attached",
        diagnostics: ["Attach a local browser tab and retry."],
      },
      "2026-09-16T12:12:00.000Z",
    );
    expect(current.gates.find((gate) => gate.id === "repository-tests")?.status).toBe("passed");
    expect(current.gates.find((gate) => gate.id === "browser-validation")?.status).toBe("blocked");
    expect(reduceValidationReadiness(current, target)).toBe("not-ready");
  });

  it("marks changed revision or dirty state stale", () => {
    const planned = run();
    expect(validationTargetEquals(target, { ...target, revision: "def456" })).toBe(false);
    expect(
      reduceValidationReadiness(planned, { ...target, dirtyStateFingerprint: "dirty-2" }),
    ).toBe("stale");
  });

  it("compares decoded validation runs by value", () => {
    const planned = run();
    expect(validationRunEquals(planned, structuredClone(planned))).toBe(true);
    expect(
      validationRunEquals(
        planned,
        structuredClone({
          ...planned,
          updatedAt: "2026-09-16T12:01:00.000Z",
        }),
      ),
    ).toBe(false);
    expect(validationRunEquals(planned, { ...planned, status: "running" })).toBe(false);
    expect(
      validationRunEquals(planned, {
        ...planned,
        lease: {
          id: "lease-1",
          executorId: "executor-1",
          claimedAt: "2026-09-16T12:00:01.000Z",
          expiresAt: "2026-09-16T12:01:00.000Z",
        },
      }),
    ).toBe(false);
    expect(
      validationRunEquals(planned, {
        ...planned,
        gates: planned.gates.map((gate, index) =>
          index === 0 ? { ...gate, kind: "lint" as const } : gate,
        ),
      }),
    ).toBe(false);
  });

  it("plans dynamic gates without trusting a caller-supplied target", () => {
    const planned = planValidationCoordinatorRun({
      id: "run-dynamic",
      requestId: "request-1",
      threadId: "thread-1" as never,
      target,
      scenarios: [{ id: "opens-settings", description: "Opens settings" }],
      scope: "full",
      requester: { id: "user-1", kind: "user" },
      requestedAt: "2026-09-16T12:00:00.000Z",
    });

    expect(planned.status).toBe("planned");
    expect(planned.gates.map((gate) => gate.kind)).toEqual([
      "format",
      "lint",
      "typecheck",
      "full-tests",
      "browser-scenario",
      "pairing-self-test",
    ]);
    expect(planned.gates[4]?.id).toContain("opens-settings");
    expect(planned.target).toBe(target);
  });

  it("accepts only legal run lifecycle transitions", () => {
    let current = planValidationCoordinatorRun({
      id: "run-lifecycle",
      requestId: "request-2",
      threadId: "thread-1" as never,
      target,
      scenarios: [],
      scope: "changed-behavior",
      requester: { id: "system", kind: "system" },
      requestedAt: "2026-09-16T12:00:00.000Z",
    });
    current = transitionValidationRunStatus(current, "preparing", "2026-09-16T12:00:01.000Z");
    current = transitionValidationRunStatus(current, "running", "2026-09-16T12:00:02.000Z");
    current = transitionValidationRunStatus(current, "blocked", "2026-09-16T12:00:03.000Z");
    expect(() =>
      transitionValidationRunStatus(current, "ready", "2026-09-16T12:00:04.000Z"),
    ).toThrow("cannot transition");
  });

  it("requires a running gate and structured result before a gate passes", () => {
    let current = planValidationCoordinatorRun({
      id: "run-result",
      requestId: "request-3",
      threadId: "thread-1" as never,
      target,
      scenarios: [],
      scope: "changed-behavior",
      requester: { id: "system", kind: "system" },
      requestedAt: "2026-09-16T12:00:00.000Z",
    });
    const result = {
      id: "result-1",
      runId: current.id,
      gateId: current.gates[0]!.id,
      attemptId: "attempt-1",
      leaseId: "lease:run-result",
      executorId: "executor-1",
      target,
      status: "passed" as const,
      observedAt: "2026-09-16T12:00:01.000Z",
      completedAt: "2026-09-16T12:00:02.000Z",
      exitCode: 0,
      outputRef: "output://focused",
      blockerReason: null,
      diagnostics: [],
    };
    expect(() => acceptValidationResult(current, result)).toThrow("run is planned");

    current = {
      ...current,
      status: "running",
      executorId: "executor-1",
      gates: current.gates.map((gate, index) =>
        index === 0
          ? {
              ...gate,
              status: "running" as const,
              startedAt: "2026-09-16T12:00:01.000Z",
            }
          : gate,
      ),
      lease: {
        id: "lease:run-result",
        executorId: "executor-1",
        claimedAt: "2026-09-16T12:00:01.000Z",
        expiresAt: "2026-09-16T12:01:00.000Z",
      },
    };
    const accepted = acceptValidationResult(current, result);
    expect(accepted.gates[0]?.result?.id).toBe("result-1");
    expect(accepted.gates[0]?.status).toBe("passed");

    for (const status of ["preparing", "blocked", "ready", "stale"] as const) {
      expect(() => acceptValidationResult({ ...current, status }, result)).toThrow(
        `run is ${status}`,
      );
    }
  });
});
