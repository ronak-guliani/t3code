import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { appendT3ExecutionContext, t3ExecutionContext } from "./executionContext.ts";

const delegation = {
  delegationAssignmentId: MessageId.make("assignment-a"),
  delegationDispatchId: "dispatch-a",
};

describe("provider execution context", () => {
  it("renders immutable report identity with a known provider turn", () => {
    expect(t3ExecutionContext(delegation, "turn-a")).toContain(
      'originTurnId="turn-a" exactly, dispatchId="dispatch-a" exactly, and assignmentId="assignment-a" exactly',
    );
  });

  it("preserves immutable delegation identity when the provider assigns the turn id", () => {
    expect(t3ExecutionContext(delegation)).toContain(
      'the current provider turn ID as originTurnId, dispatchId="dispatch-a" exactly, and assignmentId="assignment-a" exactly',
    );
  });

  it("does not alter ordinary non-delegated prompts", () => {
    expect(appendT3ExecutionContext(" hello ", {}, "turn-a")).toBe("hello");
  });
});
