import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import type { ValidationGate, ValidationTarget } from "@t3tools/contracts";

import {
  artifactScopeForRun,
  attemptNumberForAttemptId,
  browserScenarioForGate,
  isBrowserGateKind,
  isRepositoryGateKind,
  makeFileMediaPersistence,
  mapBrowserResultToStructured,
  mapRepositoryAttemptToResult,
  mediaFileNameForGate,
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
  it("scopes repository artifacts to the coordinator run id", () => {
    expect(artifactScopeForRun("validation:req-1")).toBe("validation-req-1");
    expect(artifactScopeForRun("validation:550e8400-e29b-41d4-a716-446655440000")).toBe(
      "validation-550e8400-e29b-41d4-a716-446655440000",
    );
    const scoped = artifactScopeForRun("validation:req-1");
    expect(scoped.length).toBeLessThanOrEqual(64);
    expect(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scoped)).toBe(true);
    const result = mapRepositoryAttemptToResult({
      runId: "validation:req-1",
      gate: gate(),
      attemptId: "attempt:validation:req-1:gate:2",
      leaseId: "lease:validation:req-1",
      executorId: "validation-coordinator:env-1",
      target,
      attempt: {
        status: "passed",
        exitCode: 0,
        artifact: { key: `${scoped}-lint-attempt-2`, sha256: "a".repeat(64) },
        failure: null,
        stdout: "ok",
        stderr: "",
      },
      observedAt: "2026-09-18T00:00:01.000Z",
      completedAt: "2026-09-18T00:00:02.000Z",
    });
    expect(result.outputRef).toContain(`artifact:${scoped}-lint-attempt-2:`);
  });

  it("derives the runner attempt number from the reactor attempt id", () => {
    expect(attemptNumberForAttemptId("attempt:validation:req-1:gate:1")).toBe(1);
    expect(attemptNumberForAttemptId("attempt:validation:req-1:gate:2")).toBe(2);
    expect(attemptNumberForAttemptId("attempt:1")).toBe(1);
    expect(attemptNumberForAttemptId("attempt:validation:req-1:gate:0")).toBe(1);
    expect(attemptNumberForAttemptId("attempt:validation:req-1:gate")).toBe(1);
    expect(attemptNumberForAttemptId("not-an-attempt-id")).toBe(1);
  });

  it("rejects unsafe gate-derived media filenames instead of escaping the evidence store", () => {
    expect(
      mediaFileNameForGate({
        gateId: "validation:req-1:browser-scenario:opens-settings",
        sha256: "b".repeat(64),
        kind: "screenshot",
      }),
    ).toBe(`opens-settings-${"b".repeat(16)}.png`);
    for (const gateId of [
      "validation:req-1:../../evil",
      "validation:req-1:..",
      "validation:req-1:",
      "validation:req-1:has space",
      "validation:req-1:has/slash",
    ]) {
      expect(() =>
        mediaFileNameForGate({ gateId, sha256: "b".repeat(64), kind: "recording" }),
      ).toThrow("unsafe");
    }
  });

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
    expect(passed.outputRef).toBe(`browser:screenshot:${"b".repeat(16)}`);
    expect(passed.outputRef).not.toContain("/tmp/shot.png");
    expect(passed.outputRef).not.toContain("token=");
  });

  it("keeps persisted media inside the evidence store for crafted run ids", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "t3-validation-media-"));
    const persistence = makeFileMediaPersistence(baseDir);
    const bytes = new Uint8Array([1, 2, 3]);
    const path = await persistence.persist({
      identity: { runId: "validation:../../evil", gateId: "validation:req-1:focused-tests" },
      kind: "screenshot",
      mimeType: "image/png",
      bytes,
      sha256: "c".repeat(64),
    });
    const expectedDir = join(baseDir, "validation", artifactScopeForRun("validation:../../evil"));
    expect(path.startsWith(`${expectedDir}${sep}`)).toBe(true);
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
  });
});
