import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-09-14T20:00:00.000Z";

function importCommand(): Extract<OrchestrationCommand, { type: "chat-archive.import" }> {
  return {
    type: "chat-archive.import",
    commandId: CommandId.make("import-command"),
    projectId: ProjectId.make("import-project"),
    title: "Imported chats - 2026-09-14",
    workspaceRoot: "/tmp/t3-import",
    createdAt: now,
    threads: [
      {
        threadId: ThreadId.make("import-thread"),
        parentThreadId: null,
        title: "Transferred chat",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: now,
        updatedAt: now,
        messages: [
          {
            messageId: MessageId.make("import-message"),
            role: "user",
            text: "Hello",
            turnId: TurnId.make("import-turn"),
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  };
}

describe("chat archive import decider", () => {
  it("atomically plans a reference project, chats, and messages", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: importCommand(),
        readModel: createEmptyReadModel(now),
      }),
    );
    const events = Array.isArray(result) ? result : [result];

    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
    ]);
    expect(events[0]).toMatchObject({
      payload: { kind: "chat-import", title: "Imported chats - 2026-09-14" },
    });
  });

  it("rejects agent turns on imported chats", async () => {
    const importedEvents = await Effect.runPromise(
      decideOrchestrationCommand({
        command: importCommand(),
        readModel: createEmptyReadModel(now),
      }),
    );
    let readModel = createEmptyReadModel(now);
    let sequence = 0;
    for (const event of Array.isArray(importedEvents) ? importedEvents : [importedEvents]) {
      sequence += 1;
      readModel = await Effect.runPromise(projectEvent(readModel, { ...event, sequence }));
    }

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("turn-command"),
            threadId: ThreadId.make("import-thread"),
            message: {
              messageId: MessageId.make("new-message"),
              role: "user",
              text: "Continue",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: now,
          },
        }),
      ),
    ).rejects.toThrow("reference-only");
  });

  it("rejects new chats inside imported folders", async () => {
    const importedEvents = await Effect.runPromise(
      decideOrchestrationCommand({
        command: importCommand(),
        readModel: createEmptyReadModel(now),
      }),
    );
    let readModel = createEmptyReadModel(now);
    let sequence = 0;
    for (const event of Array.isArray(importedEvents) ? importedEvents : [importedEvents]) {
      sequence += 1;
      readModel = await Effect.runPromise(projectEvent(readModel, { ...event, sequence }));
    }

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("create-command"),
            threadId: ThreadId.make("new-thread"),
            projectId: ProjectId.make("import-project"),
            parentThreadId: null,
            title: "New chat",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
        }),
      ),
    ).rejects.toThrow("cannot create new chats");
  });
});
