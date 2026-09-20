import { describe, expect, it } from "vitest";
import { ThreadId } from "@t3tools/contracts";

import { acceptanceAuthorityForThread, acceptanceAuthorityMatchesThread } from "./authority.ts";

const validDelegation = {
  assignmentId: "assignment-1",
  dispatchSequence: 4,
  dispatchId: "dispatch-1",
  dispatchTurnId: "turn-1",
};

describe("acceptanceAuthorityForThread", () => {
  it("derives the complete authority tuple used by MCP, WebSocket, and provider paths", () => {
    expect(
      acceptanceAuthorityForThread({
        id: "thread-1",
        nudging: { delegation: validDelegation },
      }),
    ).toEqual({
      executionId: "thread:thread-1",
      assignmentId: "assignment-1",
      threadId: "thread-1",
      generation: 4,
      dispatchId: "dispatch-1",
      turnId: "turn-1",
    });
  });

  it.each([
    ["missing delegation", {}],
    ["null delegation", { delegation: null }],
    ["zero generation", { ...validDelegation, dispatchSequence: 0 }],
    ["stale negative generation", { ...validDelegation, dispatchSequence: -1 }],
    ["fractional generation", { ...validDelegation, dispatchSequence: 1.5 }],
    ["missing dispatch", { ...validDelegation, dispatchId: undefined }],
    ["null turn", { ...validDelegation, dispatchTurnId: null }],
    ["empty assignment", { ...validDelegation, assignmentId: " " }],
  ])("rejects %s authority provenance", (_label, delegation) => {
    expect(
      acceptanceAuthorityForThread({
        id: "thread-1",
        nudging: { delegation },
      }),
    ).toBeUndefined();
  });

  it("rejects stale, null, and unrelated authenticated invocation tuples", () => {
    const thread = { id: "thread-1", nudging: { delegation: validDelegation } };
    const current = acceptanceAuthorityForThread(thread);
    expect(acceptanceAuthorityMatchesThread(current, thread)).toBe(true);
    expect(
      acceptanceAuthorityMatchesThread(
        current === undefined ? undefined : { ...current, generation: current.generation - 1 },
        thread,
      ),
    ).toBe(false);
    expect(acceptanceAuthorityMatchesThread(undefined, thread)).toBe(false);
    expect(
      acceptanceAuthorityMatchesThread(
        current === undefined ? undefined : { ...current, threadId: ThreadId.make("thread-2") },
        thread,
      ),
    ).toBe(false);
  });
});
