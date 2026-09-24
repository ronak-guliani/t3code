import { MessageId, ThreadId, type ChildWaitCondition } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import type { ChildFollowUpThread } from "./childFollowUp.ts";
import { childWaitBlockReason, childWaitIsSatisfied } from "./childFollowUp.ts";

const parentId = ThreadId.make("parent");
const unavailableCases: ReadonlyArray<{
  readonly description: string;
  readonly children: ReadonlyMap<ThreadId, ChildFollowUpThread>;
}> = [
  { description: "missing", children: new Map() },
  {
    description: "archived",
    children: new Map([
      [
        ThreadId.make("child-0"),
        child("child-0", "assignment-0", { archivedAt: "2026-09-09T00:00:00.000Z" }),
      ],
    ]),
  },
  {
    description: "reassigned",
    children: new Map([[ThreadId.make("child-0"), child("child-0", "new-assignment")]]),
  },
];

function wait(
  mode: ChildWaitCondition["mode"],
  outcomes: ReadonlyArray<ChildWaitCondition["assignments"][number]["outcome"]>,
): ChildWaitCondition {
  return {
    mode,
    assignments: outcomes.map((outcome, index) => ({
      childThreadId: ThreadId.make(`child-${index}`),
      assignmentId: MessageId.make(`assignment-${index}`),
      ...(outcome ? { outcome } : {}),
    })),
  };
}

function child(
  id: string,
  assignmentId: string,
  overrides: Partial<ChildFollowUpThread> = {},
): ChildFollowUpThread {
  return {
    id: ThreadId.make(id),
    parentThreadId: parentId,
    archivedAt: null,
    nudging: {
      delegation: {
        assignmentId: MessageId.make(assignmentId),
        followUp: "automatic",
        completedAt: null,
      },
    },
    ...overrides,
  };
}

describe("child wait conditions", () => {
  it.each(["result-available", "failed", "blocked"] as const)(
    "treats %s as a settled assignment",
    (outcome) => {
      expect(childWaitIsSatisfied(wait("all", [outcome]))).toBe(true);
    },
  );

  it("satisfies all only when every assignment is settled and leaves decisions-only unchanged", () => {
    expect(childWaitIsSatisfied(wait("all", ["failed", "blocked", undefined]))).toBe(false);
    expect(childWaitIsSatisfied(wait("all", ["failed", "blocked", "result-available"]))).toBe(true);
    expect(childWaitIsSatisfied(wait("any", ["failed", undefined]))).toBe(true);
    expect(childWaitIsSatisfied(wait("decisions-only", ["result-available"]))).toBe(false);
    expect(childWaitIsSatisfied(wait("all", []))).toBe(false);
  });

  it("reports only unsettled assignments as waiting", () => {
    const condition = wait("all", ["failed", "blocked", undefined]);
    const children = new Map([[ThreadId.make("child-2"), child("child-2", "assignment-2")]]);

    expect(childWaitBlockReason(condition, children, parentId)).toBe("Waiting for 1 child.");
  });

  it.each(unavailableCases)(
    "keeps an unsettled $description assignment unavailable",
    ({ children }) => {
      expect(childWaitBlockReason(wait("all", [undefined]), children, parentId)).toBe(
        "A required assignment is unavailable. Change the wait condition.",
      );
    },
  );
});
