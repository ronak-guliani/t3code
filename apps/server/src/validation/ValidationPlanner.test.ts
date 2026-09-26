import { describe, expect, it } from "vitest";

import type { ThreadId, ValidationGate, ValidationTarget } from "@t3tools/contracts";

import {
  collectChangedPathsFromCheckpoints,
  planCoordinatorRunWithPolicy,
} from "./ValidationPlanner.ts";
import { selectNextRunnableGate } from "@t3tools/client-runtime/validation-lifecycle";

const target: ValidationTarget = {
  workspaceRoot: "/workspace",
  worktreePath: "/workspace/.worktree",
  branch: "main",
  revision: "rev-1",
  dirtyStateFingerprint: "dirty-1",
  environmentIdentity: "env-1",
};

const base = {
  id: "validation:req-1",
  requestId: "req-1",
  threadId: "thread-1" as ThreadId,
  target,
  requester: { id: "user-1", kind: "user" as const },
  requestedAt: "2026-09-18T00:00:00.000Z",
};

describe("ValidationPlanner", () => {
  it("derives focused gates for server-only changed-behavior", () => {
    const run = planCoordinatorRunWithPolicy({
      ...base,
      scenarios: [],
      scope: "changed-behavior",
      changedPaths: ["apps/server/src/server.ts"],
    });
    const kinds = run.gates.filter((gate) => gate.required).map((gate) => gate.kind);
    expect(kinds).toEqual(["focused-tests", "format", "lint", "typecheck"]);
    expect(run.gates.find((gate) => gate.kind === "pairing-self-test")?.required).toBe(false);
  });

  it("uses full suite for full scope", () => {
    const run = planCoordinatorRunWithPolicy({
      ...base,
      scenarios: [],
      scope: "full",
      changedPaths: ["apps/server/src/server.ts"],
    });
    const kinds = run.gates.filter((gate) => gate.required).map((gate) => gate.kind);
    expect(kinds).toEqual(["full-tests", "format", "lint", "typecheck"]);
  });

  it("adds browser-validation for user-visible web changes without explicit scenarios", () => {
    const run = planCoordinatorRunWithPolicy({
      ...base,
      scenarios: [],
      scope: "changed-behavior",
      changedPaths: ["apps/web/src/App.tsx"],
    });
    expect(run.gates.some((gate) => gate.kind === "browser-validation" && gate.required)).toBe(
      true,
    );
  });

  it("expands explicit scenarios to browser-scenario gates and owns the plan", () => {
    const run = planCoordinatorRunWithPolicy({
      ...base,
      scenarios: [{ id: "opens-settings", description: "Opens settings" }],
      scope: "changed-behavior",
      changedPaths: ["apps/web/src/App.tsx"],
    });
    const scenarioGates = run.gates.filter((gate) => gate.kind === "browser-scenario");
    expect(scenarioGates).toHaveLength(1);
    expect(scenarioGates[0]?.id).toContain("opens-settings");
    expect(scenarioGates[0]?.required).toBe(true);
  });

  it("requires pairing-self-test only when selected by policy", () => {
    const pairing = planCoordinatorRunWithPolicy({
      ...base,
      scenarios: [],
      scope: "changed-behavior",
      changedPaths: ["scripts/self-test.ts"],
    });
    expect(pairing.gates.find((gate) => gate.kind === "pairing-self-test")?.required).toBe(true);
    const serverOnly = planCoordinatorRunWithPolicy({
      ...base,
      scenarios: [],
      scope: "changed-behavior",
      changedPaths: ["apps/server/src/server.ts"],
    });
    expect(serverOnly.gates.find((gate) => gate.kind === "pairing-self-test")?.required).toBe(
      false,
    );
    expect(serverOnly.gates.find((gate) => gate.kind === "pairing-self-test")?.status).toBe(
      "not-required",
    );
  });

  it("leaves docs-only changes with no required gates", () => {
    const run = planCoordinatorRunWithPolicy({
      ...base,
      scenarios: [],
      scope: "changed-behavior",
      changedPaths: ["docs/validation.md"],
    });
    expect(run.gates.filter((gate) => gate.required)).toHaveLength(0);
  });

  it("collects changed paths deterministically from checkpoints", () => {
    const first = collectChangedPathsFromCheckpoints([
      {
        files: [{ path: "b.ts" }],
        agentTouchedPaths: ["a.ts"],
        turnFiles: [{ path: "c.ts" }],
      },
    ]);
    const second = collectChangedPathsFromCheckpoints([
      {
        turnFiles: [{ path: "c.ts" }],
        files: [{ path: "b.ts" }],
        agentTouchedPaths: ["a.ts"],
      },
    ]);
    expect(first).toEqual(second);
    expect(first).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("selects the first pending gate only after earlier required gates pass", () => {
    const gate = (overrides: Partial<ValidationGate>): ValidationGate => ({
      id: "gate",
      label: "Gate",
      kind: "lint",
      instanceId: "gate",
      required: true,
      status: "pending",
      command: "pnpm lint",
      requestedAt: "2026-09-18T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      exitCode: null,
      outputRef: null,
      blockerReason: null,
      diagnostics: [],
      attempts: [],
      result: null,
      ...overrides,
    });
    const first = gate({ id: "first" });
    const second = gate({ id: "second" });

    expect(selectNextRunnableGate([first, second])?.id).toBe("first");
    expect(selectNextRunnableGate([{ ...first, status: "passed" }, second])?.id).toBe("second");
    // An interrupted gate is not runnable and blocks dependents until reset.
    expect(selectNextRunnableGate([{ ...first, status: "interrupted" }, second])).toBeUndefined();
    expect(
      selectNextRunnableGate([
        { ...first, status: "interrupted" },
        { ...second, status: "interrupted" },
      ]),
    ).toBeUndefined();
    // Resetting the interrupted gate to pending makes the run schedulable again.
    expect(
      selectNextRunnableGate([
        { ...first, status: "pending" },
        { ...second, status: "pending" },
      ])?.id,
    ).toBe("first");
    expect(selectNextRunnableGate([{ ...first, required: false }])).toBeUndefined();
  });
});
