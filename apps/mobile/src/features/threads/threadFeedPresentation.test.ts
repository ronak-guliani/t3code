import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationThread } from "@t3tools/contracts";
import { MessageId, TurnId } from "@t3tools/contracts";

import { buildThreadFeed } from "../../lib/threadActivity";
import {
  deriveAssistantMetadataInvalidationKey,
  deriveTerminalAssistantMessageIds,
} from "./threadFeedPresentation";

describe("thread feed assistant presentation", () => {
  it("invalidates visible rows when session completion changes without changing messages", () => {
    const running = {
      turnId: TurnId.make("turn-1"),
      state: "running" as const,
      startedAt: "2026-09-06T10:00:00.000Z",
      completedAt: null,
    };
    const completed = {
      ...running,
      state: "completed" as const,
      completedAt: "2026-09-06T10:00:04.000Z",
    };

    expect(deriveAssistantMetadataInvalidationKey(running)).not.toBe(
      deriveAssistantMetadataInvalidationKey(completed),
    );
    expect(deriveAssistantMetadataInvalidationKey(running)).toBe(
      deriveAssistantMetadataInvalidationKey({ ...running }),
    );
  });

  it("keeps only the terminal assistant message per turn eligible for the footer", () => {
    const turnId = TurnId.make("turn-1");
    const thread = {
      messages: [
        {
          id: MessageId.make("assistant-first"),
          role: "assistant",
          text: "First",
          turnId,
          streaming: false,
          createdAt: "2026-09-06T10:00:01.000Z",
          updatedAt: "2026-09-06T10:00:01.000Z",
        },
        {
          id: MessageId.make("assistant-terminal"),
          role: "assistant",
          text: "Done",
          turnId,
          streaming: false,
          createdAt: "2026-09-06T10:00:02.000Z",
          updatedAt: "2026-09-06T10:00:02.000Z",
        },
      ],
      activities: [],
    } satisfies Pick<OrchestrationThread, "messages" | "activities">;

    const terminalIds = deriveTerminalAssistantMessageIds(buildThreadFeed(thread));

    expect(terminalIds.has("assistant-first")).toBe(false);
    expect(terminalIds.has("assistant-terminal")).toBe(true);
  });
});
