import {
  CollaborationRequestId,
  CollaborationResponseId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  QueuedTurnId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-09-19T00:00:00.000Z";
const authority = (turnId: string, generation = 1) => ({
  executionId: "execution-child",
  generation,
  dispatchId: null,
  turnId: TurnId.make(turnId),
});
const delivery = (queuedTurnId: string, text: string) => ({
  queuedTurnId: QueuedTurnId.make(queuedTurnId),
  message: {
    messageId: MessageId.make(`message-${queuedTurnId}`),
    role: "user" as const,
    text,
    attachments: [],
  },
  runtimeMode: "approval-required" as const,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
});

async function makeReadModel(): Promise<OrchestrationReadModel> {
  let readModel = createEmptyReadModel(now);
  for (const [threadId, parentThreadId] of [
    ["parent", null],
    ["child", "parent"],
  ] as const) {
    readModel = await Effect.runPromise(
      projectEvent(readModel, {
        sequence: readModel.snapshotSequence + 1,
        eventId: EventId.make(`event-create-${threadId}`),
        aggregateKind: "thread",
        aggregateId: ThreadId.make(threadId),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make(`command-create-${threadId}`),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId: ThreadId.make(threadId),
          projectId: ProjectId.make("project"),
          parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
          title: threadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          pendingRuntimeMode: null,
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
  }
  return readModel;
}

describe("collaboration request protocol", () => {
  it("creates one durable request and one delivery, then deduplicates request retries", async () => {
    const readModel = await makeReadModel();
    const requestId = CollaborationRequestId.make("request-review");
    const command = {
      type: "thread.collaboration-request.create" as const,
      commandId: CommandId.make("command-request-review"),
      threadId: ThreadId.make("child"),
      requestId,
      recipientThreadId: ThreadId.make("parent"),
      kind: "review" as const,
      exchangeId: "exchange-review",
      blocking: true,
      senderAuthority: authority("turn-child"),
      recipientAuthority: authority("turn-parent"),
      producingExecution: authority("turn-child"),
      payloadRef: { ref: "payload://review", sha256: "sha-review" },
      candidateRefs: ["candidate-1"],
      findingRefs: [],
      delivery: delivery("queued-review", "Please review the candidate."),
      createdAt: now,
    };

    const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    expect(
      (result as ReadonlyArray<any>).filter((event) => event.type === "thread.queued-turn-created"),
    ).toHaveLength(1);

    let projected = readModel;
    for (const [index, event] of (result as ReadonlyArray<any>).entries()) {
      projected = await Effect.runPromise(
        projectEvent(projected, { ...event, sequence: index + 1 }),
      );
    }
    const retried = await Effect.runPromise(
      decideOrchestrationCommand({
        command: { ...command, commandId: CommandId.make("command-request-review-retry") },
        readModel: projected,
      }),
    );
    expect(retried).toEqual([]);
  });

  it("queues a response and consumes it only in a newer execution generation", async () => {
    const base = await makeReadModel();
    const requestId = CollaborationRequestId.make("request-decision");
    const createCommand = {
      type: "thread.collaboration-request.create" as const,
      commandId: CommandId.make("command-request-decision"),
      threadId: ThreadId.make("child"),
      requestId,
      recipientThreadId: ThreadId.make("parent"),
      kind: "decision" as const,
      exchangeId: "exchange-decision",
      blocking: true,
      senderAuthority: authority("turn-child"),
      recipientAuthority: authority("turn-parent"),
      producingExecution: authority("turn-child"),
      payloadRef: { ref: "payload://decision", sha256: "sha-decision" },
      candidateRefs: [],
      findingRefs: [],
      delivery: delivery("queued-decision", "Choose an approach."),
      createdAt: now,
    };
    const created = await Effect.runPromise(
      decideOrchestrationCommand({ command: createCommand, readModel: base }),
    );
    let readModel = base;
    for (const [index, event] of (Array.isArray(created) ? created : [created]).entries()) {
      readModel = await Effect.runPromise(
        projectEvent(readModel, { ...event, sequence: index + 1 }),
      );
    }

    const responded = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.collaboration-request.respond",
          commandId: CommandId.make("command-respond-decision"),
          threadId: ThreadId.make("parent"),
          requestId,
          responseId: CollaborationResponseId.make("response-decision"),
          exchangeId: "exchange-decision",
          responderAuthority: authority("turn-parent"),
          payloadRef: { ref: "payload://response", sha256: "sha-response" },
          outcome: "completed",
          delivery: delivery("queued-response", "Decision response."),
          createdAt: now,
        },
        readModel,
      }),
    );
    expect(responded).toHaveLength(3);
    for (const [index, event] of (responded as ReadonlyArray<any>).entries()) {
      readModel = await Effect.runPromise(
        projectEvent(readModel, { ...event, sequence: readModel.snapshotSequence + index + 1 }),
      );
    }

    const consumed = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.collaboration-request.consume",
          commandId: CommandId.make("command-consume-decision"),
          threadId: ThreadId.make("child"),
          requestId,
          responseId: CollaborationResponseId.make("response-decision"),
          consumedExecution: authority("turn-child-2", 2),
          createdAt: now,
        },
        readModel,
      }),
    );
    expect((consumed as ReadonlyArray<any>)[0]?.payload.request.status).toBe("consumed");
  });

  it("turns a direct parent-child circular wait into needs-human without delivery", async () => {
    const readModel = await makeReadModel();
    const existing = {
      requestId: CollaborationRequestId.make("request-parent"),
      kind: "clarification" as const,
      exchangeId: "exchange-parent",
      senderThreadId: ThreadId.make("parent"),
      recipientThreadId: ThreadId.make("child"),
      blocking: true,
      senderAuthority: authority("turn-parent"),
      recipientAuthority: authority("turn-child"),
      producingExecution: authority("turn-parent"),
      payloadRef: { ref: "payload://parent", sha256: "sha-parent" },
      candidateRefs: [],
      findingRefs: [],
      supersedesRequestId: null,
      deliveryQueuedTurnId: QueuedTurnId.make("queued-parent"),
      responseDeliveryQueuedTurnId: null,
      responseRef: null,
      response: null,
      consumedExecution: null,
      status: "waiting" as const,
      terminalOutcome: null,
      createdAt: now,
      updatedAt: now,
    };
    const withExisting = await Effect.runPromise(
      projectEvent(readModel, {
        sequence: 3,
        eventId: EventId.make("event-existing-request"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("parent"),
        type: "thread.collaboration-request-updated",
        occurredAt: now,
        commandId: CommandId.make("command-existing-request"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId: ThreadId.make("parent"),
          action: "created",
          request: existing,
          updatedAt: now,
        },
      }),
    );
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.collaboration-request.create",
          commandId: CommandId.make("command-circular-request"),
          threadId: ThreadId.make("child"),
          requestId: CollaborationRequestId.make("request-child"),
          recipientThreadId: ThreadId.make("parent"),
          kind: "clarification",
          exchangeId: "exchange-child",
          blocking: true,
          senderAuthority: authority("turn-child"),
          recipientAuthority: authority("turn-parent"),
          producingExecution: authority("turn-child"),
          payloadRef: { ref: "payload://child", sha256: "sha-child" },
          candidateRefs: [],
          findingRefs: [],
          delivery: delivery("queued-child", "Clarify this."),
          createdAt: now,
        },
        readModel: withExisting,
      }),
    );
    expect(
      (result as ReadonlyArray<any>).filter((event) => event.type === "thread.queued-turn-created"),
    ).toHaveLength(0);
    expect((result as ReadonlyArray<any>)[0]?.payload.request.terminalOutcome).toBe("needs-human");
  });
});
