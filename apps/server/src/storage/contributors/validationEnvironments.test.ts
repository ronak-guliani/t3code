import path from "node:path";

import { describe, expect, it } from "vitest";

import { validationEnvironmentStateDirectory } from "../../validation/ValidationEnvironmentService.ts";
import { classifyValidationRecord } from "./validationEnvironments.ts";

// Failure modes: a record that only looks like ours (name/cwd) is treated as
// proven; a live owner's environment is reclaimed; a dead owner is kept forever.
const baseDir = "/tmp/t3-base";
const target = {
  workspaceRoot: "/repo",
  worktreePath: null,
  branch: "main",
  revision: "abc",
  dirtyStateFingerprint: "clean",
  environmentIdentity: "env-a",
} as const;
const directory = validationEnvironmentStateDirectory(baseDir, target);
const record = (pid: number, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    target: { ...target, stateDirectory: directory },
    ownershipIdentity: "env-a:owner",
    backend: { process: { pid, startIdentity: "s", ownershipIdentity: "env-a:owner" } },
    web: { process: { pid, startIdentity: "s", ownershipIdentity: "env-a:owner" } },
    ...overrides,
  });
const classify = (raw: string | null, alive: ReadonlyArray<number> = [], at = directory) =>
  classifyValidationRecord({
    baseDir,
    directory: at,
    raw,
    probe: { currentPid: 1, isProcessAlive: (pid) => alive.includes(pid) },
  }).kind;

describe("classifyValidationRecord", () => {
  it("reclaims only a proven record whose owner processes are gone", () => {
    expect(classify(record(42))).toBe("stale");
    expect(classify(record(42), [42])).toBe("unproven");
    expect(classify(record(1))).toBe("live");
  });

  it("never treats a weaker match as proof", () => {
    expect(classify(null)).toBe("unproven");
    expect(classify("{not json")).toBe("unproven");
    expect(classify(record(42), [], path.join(baseDir, "validation", "env-a", "elsewhere"))).toBe(
      "unproven",
    );
    expect(classify(record(42, { ownershipIdentity: "env-b:owner" }))).toBe("unproven");
    expect(classify(record(42, { version: 2 }))).toBe("unproven");
  });
});
