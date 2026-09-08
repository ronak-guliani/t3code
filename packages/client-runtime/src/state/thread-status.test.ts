import { describe, expect, it } from "vite-plus/test";

import {
  hasUnseenThreadCompletion,
  isThreadActivelyWorking,
  resolveThreadSemanticStatus,
} from "./thread-status.js";

const turn = {
  turnId: "turn-1",
  state: "completed" as const,
  startedAt: "2026-09-08T10:00:00.000Z",
  completedAt: "2026-09-08T10:01:00.000Z",
};

const session = (overrides: Record<string, unknown> = {}) => ({
  status: "ready" as const,
  activeTurnId: null,
  ...overrides,
});

describe("resolveThreadSemanticStatus", () => {
  it.each([
    ["approval", { hasPendingApprovals: true, hasPendingUserInput: true }],
    ["input", { hasPendingUserInput: true }],
    ["working", { hasPendingQueuedTurn: true }],
    ["connecting", { session: session({ status: "starting" }) }],
    [
      "failed",
      { latestTurn: { ...turn, state: "error" as const }, session: session({ status: "ready" }) },
    ],
    ["plan-ready", { hasPlanReady: true }],
    ["completed", { hasUnseenCompletion: true }],
    ["ready", {}],
  ] as const)("%s has the expected semantic meaning", (expected, input) => {
    expect(
      resolveThreadSemanticStatus({
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        session: session(),
        ...input,
      }),
    ).toBe(expected);
  });

  it("keeps queued and active work above failure, connecting, and completion", () => {
    expect(
      resolveThreadSemanticStatus({
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasPendingQueuedTurn: true,
        session: session({ status: "error" }),
        latestTurn: { ...turn, state: "error" as const },
        virtualAgentRun: { status: "failed" },
        hasUnseenCompletion: true,
      }),
    ).toBe("working");
  });

  it("recognizes every failure source", () => {
    const base = {
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      session: session(),
    };
    expect(resolveThreadSemanticStatus({ ...base, session: session({ status: "error" }) })).toBe(
      "failed",
    );
    expect(resolveThreadSemanticStatus({ ...base, latestTurn: { ...turn, state: "error" } })).toBe(
      "failed",
    );
    expect(resolveThreadSemanticStatus({ ...base, virtualAgentRun: { status: "failed" } })).toBe(
      "failed",
    );
  });
});

describe("isThreadActivelyWorking", () => {
  it("does not treat a running session without an active turn as work", () => {
    expect(
      isThreadActivelyWorking({
        session: session({ status: "running", activeTurnId: null }),
        latestTurn: null,
      }),
    ).toBe(false);
  });

  it("treats queued turns and unfinished latest turns as work", () => {
    expect(isThreadActivelyWorking({ hasPendingQueuedTurn: true, session: session() })).toBe(true);
    expect(
      isThreadActivelyWorking({
        session: session({ status: "ready" }),
        latestTurn: { ...turn, state: "running", completedAt: null },
      }),
    ).toBe(true);
  });
});

describe("hasUnseenThreadCompletion", () => {
  it("uses the completion timestamp rather than the current clock", () => {
    expect(
      hasUnseenThreadCompletion({
        latestTurn: { completedAt: "2026-09-08T10:00:00.000Z" },
        lastVisitedAt: "2026-09-08T09:59:00.000Z",
      }),
    ).toBe(true);
    expect(
      hasUnseenThreadCompletion({
        latestTurn: { completedAt: "2026-09-08T10:00:00.000Z" },
        lastVisitedAt: "2026-09-08T10:00:00.000Z",
      }),
    ).toBe(false);
  });
});
