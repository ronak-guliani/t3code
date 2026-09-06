import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  CommandId,
  ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { decodeQueuedThreadMessage, encodeQueuedThreadMessage } from "../state/thread-outbox-model";

import {
  buildProjectThreadStartTurnInput,
  deriveThreadTitleFromPrompt,
} from "./projectThreadStartTurn";

const decodeCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);

describe("project thread title", () => {
  it("keeps ordinary titles and the empty-prompt fallback", () => {
    expect(deriveThreadTitleFromPrompt("  Fix\n the parser  ")).toBe("Fix the parser");
    expect(deriveThreadTitleFromPrompt(" \n ")).toBe("New thread");
  });

  describe("subchat first turn", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("copilot"),
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const queued = {
      environmentId: EnvironmentId.make("local"),
      threadId: ThreadId.make("child"),
      commandId: CommandId.make("create-child"),
      messageId: MessageId.make("first-message"),
      text: "Implement mobile nesting",
      attachments: [],
      createdAt: "2026-09-05T12:00:00Z",
      modelSelection: selection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      creation: {
        projectId: ProjectId.make("project"),
        parentThreadId: ThreadId.make("parent"),
        projectCwd: "/repo",
        workspaceMode: "local" as const,
        branch: "feature",
        worktreePath: "/repo-child",
      },
    };

    it("retains ancestry, workspace and model options across durable outbox decoding and RPC encoding", () => {
      const restored = decodeQueuedThreadMessage(encodeQueuedThreadMessage(queued));
      expect(restored).toEqual(queued);
      const input = buildProjectThreadStartTurnInput({
        ...queued,
        ...queued.creation,
        uploadedAttachments: [],
        startFromOrigin: false,
        worktreeBranchName: "unused",
      });
      const command = decodeCommand({
        type: "thread.turn.start",
        ...input,
      });
      expect(command).toMatchObject({
        commandId: queued.commandId,
        modelSelection: selection,
        bootstrap: {
          createThread: {
            parentThreadId: "parent",
            worktreePath: "/repo-child",
            branch: "feature",
            modelSelection: selection,
          },
        },
      });
      expect(input.bootstrap).not.toHaveProperty("prepareWorktree");
    });

    it("isolates only on explicit workspace selection, preserving the parent relationship", () => {
      const input = buildProjectThreadStartTurnInput({
        ...queued,
        ...queued.creation,
        uploadedAttachments: [],
        startFromOrigin: false,
        workspaceMode: "worktree",
        worktreeBranchName: "child-isolation",
      });
      expect(input.bootstrap.createThread).toMatchObject({
        parentThreadId: "parent",
        worktreePath: null,
      });
      expect(input.bootstrap.prepareWorktree).toMatchObject({
        projectCwd: "/repo",
        baseBranch: "feature",
        branch: "child-isolation",
      });
    });
  });

  it.each([
    {
      comment: undefined,
      title: "Keep `cache[key]` & <parser> shared. Retry!",
    },
    {
      comment: 'Why "shared"?',
      title: 'Keep `cache[key]` & <parser> shared. Retry! Comment: Why "shared"?',
    },
  ])("uses readable titles and intact links with comment $comment", ({ comment, title }) => {
    const quoteText = "Keep `cache[key]` & <parser> shared.\n  Retry!";
    const text = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("source-environment"),
      threadId: ThreadId.make("source-thread"),
      messageId: MessageId.make("source-message"),
      text: quoteText,
      ...(comment === undefined ? {} : { comment }),
      start: 0,
      end: quoteText.length,
      prefix: "",
      suffix: "",
    });
    const input = buildProjectThreadStartTurnInput({
      projectId: ProjectId.make("project"),
      projectCwd: "/workspace",
      threadId: "new-thread",
      commandId: "command",
      messageId: "message",
      createdAt: "2026-09-01T00:00:00Z",
      text,
      uploadedAttachments: [],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    });

    expect(input.titleSeed).toBe(title);
    expect(input.bootstrap.createThread.title).toBe(input.titleSeed);
    expect(input.message.text).toBe(text);
  });
});
