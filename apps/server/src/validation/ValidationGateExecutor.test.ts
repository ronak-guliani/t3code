import { describe, expect, it } from "vitest";

import type { ValidationGate, ValidationTarget } from "@t3tools/contracts";

import {
  browserScenarioForGate,
  isBrowserGateKind,
  isRepositoryGateKind,
  mapBrowserResultToStructured,
  mapRepositoryAttemptToResult,
  repositoryGateIdForKind,
} from "./ValidationGateExecutor.ts";

const target: ValidationTarget = {
  workspaceRoot: "/workspace",
  worktreePath: "/workspace/.worktree",
  branch: "main",
  revision: "rev-1",
  dirtyStateFingerprint: "dirty-1",
  environmentIdentity: "env-1",
};

const gate = (overrides: Partial<ValidationGate> = {}): ValidationGate => ({
  id: "validation:req-1:focused-tests",
  label: "Focused tests",
  kind: "focused-tests",
  instanceId: "validation:req-1:focused-tests",
  required: true,
  status: "running",
  command: null,
  requestedAt: "2026-09-18T00:00:00.000Z",
  startedAt: "2026-09-18T00:00:01.000Z",
  completedAt: null,
  exitCode: null,
  outputRef: null,
  blockerReason: null,
  diagnostics: [],
  attempts: [],
  result: null,
  ...overrides,
});

describe("ValidationGateExecutor mapping", () => {
  it("maps repository kinds without copying runner logic", () => {
    expect(repositoryGateIdForKind("focused-tests")).toBe("focused-tests");
    expect(repositoryGateIdForKind("pairing-self-test")).toBe("pairing-self-test");
    expect(repositoryGateIdForKind("browser-scenario")).toBeNull();
    expect(isRepositoryGateKind("lint")).toBe(true);
    expect(isBrowserGateKind("browser-scenario")).toBe(true);
    expect(isBrowserGateKind("browser-validation")).toBe(true);
    expect(isBrowserGateKind("lint")).toBe(false);
  });

  it("maps invalid-spec to blocked and timeout to interrupted", () => {
    const blocked = mapRepositoryAttemptToResult({
      runId: "validation:req-1",
      gate: gate(),
      attemptId: "attempt:1",
      leaseId: "lease:validation:req-1",
      executorId: "validation-coordinator:env-1",
      target,
      attempt: {
        status: "failed",
        exitCode: null,
        artifact: null,
        failure: { kind: "invalid-spec", message: "cwd must not be empty." },
        stdout: "",
        stderr: "",
      },
      observedAt: "2026-09-18T00:00:01.000Z",
      completedAt: "2026-09-18T00:00:02.000Z",
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockerReason).toContain("cwd");

    const interrupted = mapRepositoryAttemptToResult({
      runId: "validation:req-1",
      gate: gate(),
      attemptId: "attempt:2",
      leaseId: "lease:validation:req-1",
      executorId: "validation-coordinator:env-1",
      target,
      attempt: {
        status: "interrupted",
        exitCode: null,
        artifact: null,
        failure: { kind: "timeout", message: "Validation timed out." },
        stdout: "partial",
        stderr: "",
      },
      observedAt: "2026-09-18T00:00:01.000Z",
      completedAt: "2026-09-18T00:00:02.000Z",
    });
    expect(interrupted.status).toBe("interrupted");
  });

  it("bounds output references and redacts credentials", () => {
    const result = mapRepositoryAttemptToResult({
      runId: "validation:req-1",
      gate: gate(),
      attemptId: "attempt:1",
      leaseId: "lease:validation:req-1",
      executorId: "validation-coordinator:env-1",
      target,
      attempt: {
        status: "failed",
        exitCode: 1,
        artifact: { key: "lint-attempt-1", sha256: "a".repeat(64) },
        failure: { kind: "nonzero-exit", message: "Validation exited with code 1." },
        stdout: "ok ?token=secret123 credential=abc",
        stderr: "",
      },
      observedAt: "2026-09-18T00:00:01.000Z",
      completedAt: "2026-09-18T00:00:02.000Z",
    });
    expect(result.outputRef).toContain("artifact:lint-attempt-1:");
    expect(result.outputRef!.length).toBeLessThanOrEqual(200);
    const joined = result.diagnostics.join(" ");
    expect(joined).not.toContain("secret123");
    expect(joined).not.toContain("credential=abc");
  });

  it("expands browser scenarios with explicit assertions and screenshot evidence", () => {
    const browserGate = gate({
      id: "validation:req-1:browser-scenario:opens-settings",
      label: "Opens settings",
      kind: "browser-scenario",
    });
    const scenario = browserScenarioForGate({
      gate: browserGate,
      scenarioId: "opens-settings",
      webOrigin: "http://127.0.0.1:3773",
      webPort: 3773,
    });
    expect(scenario.id).toBe("opens-settings");
    expect(scenario.assertions.length).toBeGreaterThan(0);
    expect(scenario.media.some((requirement) => requirement.kind === "screenshot")).toBe(true);
    expect(
      scenario.media.some(
        (requirement) => requirement.kind === "recording" && requirement.required,
      ),
    ).toBe(false);
  });

  it("maps browser outcomes without success-shaped fallback evidence", () => {
    const browserGate = gate({
      id: "validation:req-1:browser-validation",
      kind: "browser-validation",
      label: "Browser validation",
    });
    const blocked = mapBrowserResultToStructured({
      runId: "validation:req-1",
      gate: browserGate,
      attemptId: "attempt:1",
      leaseId: "lease:validation:req-1",
      executorId: "validation-coordinator:env-1",
      target,
      outcome: "blocked",
      evidence: {
        media: [],
        diagnostics: { console: [], network: [] },
        assertions: [],
        authentication: { passed: false },
      },
      diagnostics: [{ message: "The preview automation credential is invalid." }],
      observedAt: "2026-09-18T00:00:01.000Z",
      completedAt: "2026-09-18T00:00:02.000Z",
      envSummary:
        "environment env-1 backend http://127.0.0.1:3773:3773 pid 123 web http://127.0.0.1:3773:3773 pid 123",
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.outputRef).toBeNull();
    expect(blocked.blockerReason).toContain("credential");

    const passed = mapBrowserResultToStructured({
      runId: "validation:req-1",
      gate: browserGate,
      attemptId: "attempt:1",
      leaseId: "lease:validation:req-1",
      executorId: "validation-coordinator:env-1",
      target,
      outcome: "passed",
      evidence: {
        media: [{ kind: "screenshot", sha256: "b".repeat(64), persistedPath: "/tmp/shot.png" }],
        diagnostics: { console: [], network: [] },
        assertions: [{ id: "app-text", passed: true, observed: "T3" }],
        authentication: { passed: true },
      },
      diagnostics: [],
      observedAt: "2026-09-18T00:00:01.000Z",
      completedAt: "2026-09-18T00:00:02.000Z",
      envSummary: "environment env-1",
    });
    expect(passed.status).toBe("passed");
    expect(passed.outputRef).toContain("browser:screenshot:");
    expect(passed.outputRef).not.toContain("token=");
  });
});
