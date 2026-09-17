import { describe, expect, it } from "vitest";

import {
  planValidationRun,
  reduceValidationReadiness,
  transitionValidationGate,
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
});
