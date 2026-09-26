import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  COPILOT_POST_COMPLETION_WARNING_CODE,
  hasCopilotPostCompletionWarning,
} from "./copilotCompletionToast";

function warning(id: string, code: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind: "runtime.warning",
    tone: "info",
    summary: "Runtime warning",
    payload: { detail: { code } },
    turnId: null,
    createdAt: "2026-09-06T00:00:00Z",
  };
}

describe("hasCopilotPostCompletionWarning", () => {
  it("detects the post-completion warning", () => {
    expect(
      hasCopilotPostCompletionWarning([warning("first", COPILOT_POST_COMPLETION_WARNING_CODE)]),
    ).toBe(true);
  });

  it("ignores other warnings and malformed payloads", () => {
    expect(
      hasCopilotPostCompletionWarning([
        warning("other", "other-warning"),
        { ...warning("malformed", COPILOT_POST_COMPLETION_WARNING_CODE), payload: null },
        {
          ...warning("not-warning", COPILOT_POST_COMPLETION_WARNING_CODE),
          kind: "tool.completed",
        },
      ]),
    ).toBe(false);
  });

  it("returns false without activities", () => {
    expect(hasCopilotPostCompletionWarning(undefined)).toBe(false);
    expect(hasCopilotPostCompletionWarning([])).toBe(false);
  });
});
