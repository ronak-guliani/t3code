import { describe, expect, it } from "vitest";

import { isThreadIdleForTerminalReaper } from "./IdleTerminalReaper.ts";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const IDLE_AT = new Date(NOW - 5 * 60 * 60 * 1_000).toISOString();
const THRESHOLD_MS = 4 * 60 * 60 * 1_000;

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-1",
    updatedAt: IDLE_AT,
    latestUserMessageAt: IDLE_AT,
    latestTurn: {
      requestedAt: IDLE_AT,
      startedAt: IDLE_AT,
      completedAt: IDLE_AT,
      state: "completed",
    },
    pendingTurnStart: null,
    hasPendingQueuedTurn: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pinnedAt: null,
    session: { activeTurnId: null },
    ...overrides,
  } as never;
}

describe("idle terminal thread eligibility", () => {
  it("allows an idle, unpinned thread with no active or queued turn", () => {
    expect(isThreadIdleForTerminalReaper(thread(), NOW, THRESHOLD_MS)).toBe(true);
  });

  it.each([
    ["recent thread activity", { updatedAt: new Date(NOW).toISOString() }],
    ["recent user message", { latestUserMessageAt: new Date(NOW).toISOString() }],
    [
      "recent turn activity",
      { latestTurn: { requestedAt: new Date(NOW).toISOString(), state: "completed" } },
    ],
    ["active turn", { session: { activeTurnId: "turn-active" } }],
    ["pending turn start", { pendingTurnStart: { requestedAt: IDLE_AT } }],
    ["queued turn", { hasPendingQueuedTurn: true }],
    ["pinned thread", { pinnedAt: IDLE_AT }],
    ["pending approval", { hasPendingApprovals: true }],
    ["pending user input", { hasPendingUserInput: true }],
  ])("keeps a thread with %s", (_reason, overrides) => {
    expect(isThreadIdleForTerminalReaper(thread(overrides), NOW, THRESHOLD_MS)).toBe(false);
  });
});
