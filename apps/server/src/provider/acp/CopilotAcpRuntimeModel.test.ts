import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vitest";

import type { AcpParsedSessionEvent, AcpToolCallState } from "./AcpRuntimeModel.ts";
import {
  extractCopilotPlanUpdate,
  normalizeCopilotParsedSessionEvent,
  normalizeCopilotPermissionRequest,
  normalizeCopilotToolCallState,
  shouldSuppressCopilotContentDelta,
} from "./CopilotAcpRuntimeModel.ts";

describe("CopilotAcpRuntimeModel", () => {
  it("uses _meta.claudeCode.toolName to normalize command tools", () => {
    const normalized = normalizeCopilotToolCallState({
      toolCallId: "tool-bash-1",
      kind: "other",
      title: "Tool",
      status: "pending",
      data: {
        toolCallId: "tool-bash-1",
        kind: "other",
        _meta: {
          claudeCode: {
            toolName: "Bash",
          },
        },
        rawInput: {
          command: ["bun", "run", "typecheck"],
        },
      },
    });

    expect(normalized).toMatchObject({
      itemType: "command_execution",
      kind: "execute",
      title: "Ran command",
      command: "bun run typecheck",
      detail: "bun run typecheck",
      data: {
        copilotToolName: "Bash",
        itemType: "command_execution",
        kind: "execute",
        command: "bun run typecheck",
      },
    });
  });

  it("infers file, web, and subagent tool types from weak Copilot identity", () => {
    const edit = normalizeCopilotToolCallState({
      toolCallId: "edit-1",
      kind: "other",
      title: "Edit",
      status: "completed",
      data: {
        rawInput: {
          filePath: "src/app.ts",
          newText: "content",
        },
      },
    });
    expect(edit.itemType).toBe("file_change");
    expect(edit.kind).toBe("edit");
    expect(edit.title).toBe("Changed files");
    expect(edit.detail).toBe("src/app.ts");

    const search = normalizeCopilotToolCallState({
      toolCallId: "search-1",
      kind: "other",
      title: "WebSearch",
      status: "completed",
      data: {
        rawInput: {
          query: "agent client protocol",
        },
      },
    });
    expect(search.itemType).toBe("web_search");
    expect(search.kind).toBe("search");

    const task = normalizeCopilotToolCallState({
      toolCallId: "task-1",
      kind: "other",
      title: "Task",
      status: "pending",
      data: {},
    });
    expect(task.itemType).toBe("collab_agent_tool_call");
    expect(task.kind).toBe("subagent");
  });

  it("parses TodoWrite-like payloads into plan updates", () => {
    const toolCall: AcpToolCallState = {
      toolCallId: "todo-1",
      kind: "other",
      status: "completed",
      data: {
        rawInput: {
          todos: [
            { content: "Inspect state", status: "completed" },
            { content: "Patch parser", status: "in_progress" },
            { content: "Run tests", status: "pending" },
          ],
        },
      },
    };

    expect(extractCopilotPlanUpdate(toolCall)).toEqual({
      plan: [
        { step: "Inspect state", status: "completed" },
        { step: "Patch parser", status: "inProgress" },
        { step: "Run tests", status: "pending" },
      ],
    });
  });

  it("parses markdown task lists written to plan-like files", () => {
    const toolCall: AcpToolCallState = {
      toolCallId: "plan-file-1",
      kind: "write",
      data: {
        rawInput: {
          path: ".copilot/plan.md",
          content: "- [x] Read code\n- [-] Implement parser\n- [ ] Run tests",
        },
      },
    };

    expect(extractCopilotPlanUpdate(toolCall)).toEqual({
      plan: [
        { step: "Read code", status: "completed" },
        { step: "Implement parser", status: "inProgress" },
        { step: "Run tests", status: "pending" },
      ],
    });
  });

  it("suppresses Copilot thought chunks from assistant text", () => {
    const event: AcpParsedSessionEvent = {
      _tag: "ContentDelta",
      text: "private reasoning",
      rawPayload: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          _meta: {
            kind: "reasoning",
          },
          content: {
            type: "text",
            text: "private reasoning",
          },
        },
      },
    };

    expect(shouldSuppressCopilotContentDelta(event)).toBe(true);
    expect(normalizeCopilotParsedSessionEvent(event)).toEqual([]);
  });

  it("normalizes permission requests even without a prior tool notification", () => {
    const request = normalizeCopilotPermissionRequest({
      sessionId: "session-1",
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      toolCall: {
        toolCallId: "perm-1",
        kind: "other",
        status: "pending",
        title: "Run shell command",
        _meta: {
          claudeCode: {
            toolName: "Bash",
          },
        },
        rawInput: {
          command: "npm test",
        },
      },
    } satisfies EffectAcpSchema.RequestPermissionRequest);

    expect(request).toMatchObject({
      kind: "execute",
      detail: "npm test",
      toolCall: {
        itemType: "command_execution",
        title: "Ran command",
        command: "npm test",
      },
    });
  });

  it("keeps malformed unknown tools renderable as dynamic tool calls", () => {
    const normalized = normalizeCopilotToolCallState({
      toolCallId: "unknown-1",
      status: "failed",
      data: {
        rawInput: {
          nested: { value: true },
        },
      },
    });

    expect(normalized.itemType).toBe("dynamic_tool_call");
    expect(normalized.title).toBe("Tool");
    expect(normalized.data.itemType).toBe("dynamic_tool_call");
  });
});
