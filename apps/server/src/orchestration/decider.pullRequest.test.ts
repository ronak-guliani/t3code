import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-09-14T20:00:00.000Z";
const threadId = ThreadId.make("thread-pr-idempotence");
const projectId = ProjectId.make("project-pr-idempotence");
const pullRequest = {
  number: 42,
  title: "Link pull request",
  url: "https://github.com/acme/app/pull/42",
  baseBranch: "main",
  headBranch: "feature/link-pr",
  state: "open" as const,
};

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

async function makeReadModel() {
  return Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: EventId.make("thread-created"),
      type: "thread.created",
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: now,
      commandId: CommandId.make("create-thread"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        projectId,
        title: "PR idempotence",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

function linkCommand(
  source: Extract<OrchestrationCommand, { type: "thread.pull-request.link" }>["source"] = "manual",
): Extract<OrchestrationCommand, { type: "thread.pull-request.link" }> {
  return {
    type: "thread.pull-request.link",
    commandId: CommandId.make(`link-${source}`),
    threadId,
    pullRequest,
    source,
  };
}

describe("pull request link decider", () => {
  it("does not emit duplicate link or absent unlink events", async () => {
    let readModel = await makeReadModel();
    const firstLink = await Effect.runPromise(
      decideOrchestrationCommand({ command: linkCommand(), readModel }),
    );
    expect(Array.isArray(firstLink) ? firstLink : [firstLink]).toHaveLength(1);

    readModel = await Effect.runPromise(
      projectEvent(
        readModel,
        makeEvent({
          sequence: 2,
          type: "thread.pull-request-linked",
          payload: {
            threadId,
            link: { pullRequest, source: "manual", linkedAt: now },
            updatedAt: now,
          },
        }),
      ),
    );

    const duplicateLink = await Effect.runPromise(
      decideOrchestrationCommand({ command: linkCommand(), readModel }),
    );
    expect(duplicateLink).toEqual([]);

    const absentUnlink = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.unlink",
          commandId: CommandId.make("unlink-absent"),
          threadId,
          pullRequest: { ...pullRequest, number: 43, url: "https://github.com/acme/app/pull/43" },
        },
        readModel,
      }),
    );
    expect(absentUnlink).toEqual([]);
  });

  it("emits a refresh event when linked association data changes", async () => {
    let readModel = await makeReadModel();
    readModel = await Effect.runPromise(
      projectEvent(
        readModel,
        makeEvent({
          sequence: 2,
          type: "thread.pull-request-linked",
          payload: {
            threadId,
            link: { pullRequest, source: "created", linkedAt: now },
            updatedAt: now,
          },
        }),
      ),
    );

    const refreshed = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          ...linkCommand("created"),
          pullRequest: { ...pullRequest, title: "Updated title" },
        },
        readModel,
      }),
    );
    expect(refreshed).toMatchObject({
      type: "thread.pull-request-linked",
      payload: {
        link: { source: "created", linkedAt: now, pullRequest: { title: "Updated title" } },
      },
    });
  });
});
