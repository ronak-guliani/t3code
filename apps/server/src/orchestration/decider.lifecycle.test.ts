import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const commandId = CommandId.make("cmd-lifecycle");
const projectId = ProjectId.make("project-lifecycle");
const threadId = ThreadId.make("thread-lifecycle");

async function lifecycleReadModel(): Promise<OrchestrationReadModel> {
  const now = "2026-07-30T00:00:00.000Z";
  const model = createEmptyReadModel(now);
  return Effect.runPromise(
    projectEvent(model, {
      sequence: 1,
      eventId: EventId.make("event-thread-lifecycle"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: now,
      commandId,
      causationEventId: null,
      correlationId: commandId,
      metadata: {},
      payload: {
        threadId,
        projectId,
        parentThreadId: null,
        title: "Lifecycle thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        pendingRuntimeMode: null,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

describe("decider thread lifecycle", () => {
  it("settles and reopens an eligible thread", async () => {
    const readModel = await lifecycleReadModel();
    const settled = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId,
          threadId,
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    if (!("type" in settled)) {
      throw new Error("Expected settlement to emit one event.");
    }
    expect(settled.type).toBe("thread.settled");

    const reopened = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId,
          threadId,
          reason: "user",
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    expect(reopened).toMatchObject({
      type: "thread.unsettled",
      payload: { threadId, reason: "user" },
    });
  });

  it("stores a future snooze and permits an explicit wake", async () => {
    const readModel = await lifecycleReadModel();
    const snoozed = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId,
          threadId,
          snoozedUntil: "2026-07-31T00:00:00.000Z",
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    expect(snoozed).toMatchObject({
      type: "thread.snoozed",
      payload: { threadId, snoozedUntil: "2026-07-31T00:00:00.000Z" },
    });

    const woken = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unsnooze",
          commandId,
          threadId,
          reason: "user",
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    expect(woken).toMatchObject({
      type: "thread.unsnoozed",
      payload: { threadId, reason: "user" },
    });
  });
});
