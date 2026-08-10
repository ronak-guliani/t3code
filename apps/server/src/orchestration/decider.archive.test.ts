import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const PROJECT_ID = "project-archive";

async function seedThread(
  readModel: OrchestrationReadModel,
  input: { sequence: number; id: string; parentThreadId: string | null },
): Promise<OrchestrationReadModel> {
  const now = new Date().toISOString();
  return Effect.runPromise(
    projectEvent(readModel, {
      sequence: input.sequence,
      eventId: asEventId(`evt-thread-${input.id}`),
      aggregateKind: "thread",
      aggregateId: asThreadId(input.id),
      type: "thread.created",
      occurredAt: now,
      commandId: asCommandId(`cmd-thread-${input.id}`),
      causationEventId: null,
      correlationId: asCommandId(`cmd-thread-${input.id}`),
      metadata: {},
      payload: {
        threadId: asThreadId(input.id),
        projectId: asProjectId(PROJECT_ID),
        parentThreadId: input.parentThreadId ? asThreadId(input.parentThreadId) : null,
        title: `Thread ${input.id}`,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        pendingRuntimeMode: null,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

async function seedReadModel(): Promise<OrchestrationReadModel> {
  const now = new Date().toISOString();
  let readModel = createEmptyReadModel(now);
  readModel = await Effect.runPromise(
    projectEvent(readModel, {
      sequence: 1,
      eventId: asEventId("evt-project-create"),
      aggregateKind: "project",
      aggregateId: asProjectId(PROJECT_ID),
      type: "project.created",
      occurredAt: now,
      commandId: asCommandId("cmd-project-create"),
      causationEventId: null,
      correlationId: asCommandId("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: asProjectId(PROJECT_ID),
        title: "Project Archive",
        workspaceRoot: "/tmp/project-archive",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  // parent -> child -> grandchild, plus an unrelated root thread.
  readModel = await seedThread(readModel, { sequence: 2, id: "parent", parentThreadId: null });
  readModel = await seedThread(readModel, {
    sequence: 3,
    id: "child",
    parentThreadId: "parent",
  });
  readModel = await seedThread(readModel, {
    sequence: 4,
    id: "grandchild",
    parentThreadId: "child",
  });
  readModel = await seedThread(readModel, {
    sequence: 5,
    id: "unrelated",
    parentThreadId: null,
  });
  return readModel;
}

describe("decider archive cascade", () => {
  it("decouples a nested thread so later parent archive does not include it", async () => {
    const readModel = await seedReadModel();
    const decoupled = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.decouple",
          commandId: asCommandId("cmd-decouple-child"),
          threadId: asThreadId("child"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const decoupledEvent = Array.isArray(decoupled) ? decoupled[0] : decoupled;
    expect(decoupledEvent?.type).toBe("thread.decoupled");

    const updatedReadModel = await Effect.runPromise(
      projectEvent(readModel, { ...decoupledEvent!, sequence: 6 }),
    );
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-parent"),
          threadId: asThreadId("parent"),
        } satisfies OrchestrationCommand,
        readModel: updatedReadModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    expect(
      updatedReadModel.threads.find((thread) => thread.id === asThreadId("child"))?.parentThreadId,
    ).toBeNull();
    expect(events.map((event) => event.payload.threadId)).toEqual([asThreadId("parent")]);
  });

  it("archives the target thread and every descendant, parents first", async () => {
    const readModel = await seedReadModel();

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-parent"),
          threadId: asThreadId("parent"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    expect(events.map((event) => event.type)).toEqual([
      "thread.archived",
      "thread.archived",
      "thread.archived",
    ]);
    expect(events.map((event) => event.payload.threadId)).toEqual([
      asThreadId("parent"),
      asThreadId("child"),
      asThreadId("grandchild"),
    ]);
  });

  it("does not archive unrelated threads", async () => {
    const readModel = await seedReadModel();

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-parent"),
          threadId: asThreadId("parent"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    expect(events.map((event) => event.payload.threadId)).not.toContain(asThreadId("unrelated"));
  });

  it("reaches active descendants through an already archived child", async () => {
    const now = new Date().toISOString();
    const readModel = await Effect.runPromise(
      projectEvent(await seedReadModel(), {
        sequence: 6,
        eventId: asEventId("evt-archive-child"),
        aggregateKind: "thread",
        aggregateId: asThreadId("child"),
        type: "thread.archived",
        occurredAt: now,
        commandId: asCommandId("cmd-archive-child"),
        causationEventId: null,
        correlationId: asCommandId("cmd-archive-child"),
        metadata: {},
        payload: {
          threadId: asThreadId("child"),
          archivedAt: now,
          updatedAt: now,
        },
      }),
    );

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-parent"),
          threadId: asThreadId("parent"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    expect(events.map((event) => event.payload.threadId)).toEqual([
      asThreadId("parent"),
      asThreadId("grandchild"),
    ]);
  });

  it("archives only the leaf when a child chat is archived directly", async () => {
    const readModel = await seedReadModel();

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-grandchild"),
          threadId: asThreadId("grandchild"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];

    expect(events.map((event) => event.payload.threadId)).toEqual([asThreadId("grandchild")]);
  });

  it("requests worktree cleanup when archiving a merged-PR sole owner", async () => {
    const worktreePath = "/tmp/project-archive-merged-worktree";
    const baseReadModel = await seedReadModel();
    const readModel: OrchestrationReadModel = {
      ...baseReadModel,
      threads: baseReadModel.threads.map((thread) =>
        thread.id === asThreadId("grandchild")
          ? {
              ...thread,
              worktreePath,
              pullRequest: {
                number: 42,
                title: "Merged feature",
                url: "https://github.com/example/repo/pull/42",
                baseBranch: "main",
                headBranch: "feature",
                state: "merged",
              },
            }
          : thread,
      ),
    };

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-merged-cleanup"),
          threadId: asThreadId("grandchild"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe("thread.archived");
    if (event?.type === "thread.archived") {
      expect(event.payload.worktreeCleanup).toEqual({
        cwd: "/tmp/project-archive",
        path: worktreePath,
      });
    }
  });

  it("does not request cleanup when archived PR is still open", async () => {
    const worktreePath = "/tmp/project-archive-open-worktree";
    const baseReadModel = await seedReadModel();
    const readModel: OrchestrationReadModel = {
      ...baseReadModel,
      threads: baseReadModel.threads.map((thread) =>
        thread.id === asThreadId("grandchild")
          ? {
              ...thread,
              worktreePath,
              pullRequest: {
                number: 43,
                title: "Open feature",
                url: "https://github.com/example/repo/pull/43",
                baseBranch: "main",
                headBranch: "feature-open",
                state: "open",
              },
            }
          : thread,
      ),
    };

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-open-no-cleanup"),
          threadId: asThreadId("grandchild"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];
    const event = events[0];
    expect(event?.type).toBe("thread.archived");
    if (event?.type === "thread.archived") {
      expect(event.payload.worktreeCleanup).toBeUndefined();
    }
  });

  it("does not request cleanup while another active thread still owns the worktree", async () => {
    const worktreePath = "/tmp/project-archive-shared-worktree";
    const baseReadModel = await seedReadModel();
    const readModel: OrchestrationReadModel = {
      ...baseReadModel,
      threads: baseReadModel.threads.map((thread) => {
        if (thread.id === asThreadId("grandchild")) {
          return {
            ...thread,
            worktreePath,
            pullRequest: {
              number: 44,
              title: "Merged shared",
              url: "https://github.com/example/repo/pull/44",
              baseBranch: "main",
              headBranch: "feature-shared",
              state: "merged",
            },
          };
        }
        if (thread.id === asThreadId("unrelated")) {
          return { ...thread, worktreePath };
        }
        return thread;
      }),
    };

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-shared-no-cleanup"),
          threadId: asThreadId("grandchild"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];
    const event = events[0];
    expect(event?.type).toBe("thread.archived");
    if (event?.type === "thread.archived") {
      expect(event.payload.worktreeCleanup).toBeUndefined();
    }
  });

  it("dedupes cleanup to one thread when an archive batch shares a merged worktree", async () => {
    const worktreePath = "/tmp/project-archive-batch-worktree";
    const baseReadModel = await seedReadModel();
    const mergedPr = {
      number: 45,
      title: "Merged batch",
      url: "https://github.com/example/repo/pull/45",
      baseBranch: "main",
      headBranch: "feature-batch",
      state: "merged" as const,
    };
    const readModel: OrchestrationReadModel = {
      ...baseReadModel,
      threads: baseReadModel.threads.map((thread) =>
        thread.id === asThreadId("parent") ||
        thread.id === asThreadId("child") ||
        thread.id === asThreadId("grandchild")
          ? { ...thread, worktreePath, pullRequest: mergedPr }
          : thread,
      ),
    };

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-batch-cleanup"),
          threadId: asThreadId("parent"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];
    const cleanupEvents = events.filter(
      (event) => event.type === "thread.archived" && event.payload.worktreeCleanup !== undefined,
    );
    expect(cleanupEvents).toHaveLength(1);
    const cleanupEvent = cleanupEvents[0];
    if (cleanupEvent?.type === "thread.archived") {
      expect(cleanupEvent.payload.worktreeCleanup).toEqual({
        cwd: "/tmp/project-archive",
        path: worktreePath,
      });
    }
  });

  it("dedupes cleanup across canonical path aliases in one archive batch", async () => {
    const canonicalWorktreePath = "/tmp/project-archive-alias-worktree";
    const aliasWorktreePath = "/tmp/parent/../project-archive-alias-worktree";
    const baseReadModel = await seedReadModel();
    const mergedPr = {
      number: 46,
      title: "Merged aliases",
      url: "https://github.com/example/repo/pull/46",
      baseBranch: "main",
      headBranch: "feature-alias",
      state: "merged" as const,
    };
    const readModel: OrchestrationReadModel = {
      ...baseReadModel,
      threads: baseReadModel.threads.map((thread) => {
        if (thread.id === asThreadId("parent")) {
          return { ...thread, worktreePath: canonicalWorktreePath, pullRequest: mergedPr };
        }
        if (thread.id === asThreadId("child")) {
          return { ...thread, worktreePath: aliasWorktreePath, pullRequest: mergedPr };
        }
        return thread;
      }),
    };

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-alias-cleanup"),
          threadId: asThreadId("parent"),
        } satisfies OrchestrationCommand,
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];
    const cleanupEvents = events.filter(
      (event) => event.type === "thread.archived" && event.payload.worktreeCleanup !== undefined,
    );
    expect(cleanupEvents).toHaveLength(1);
    const cleanupEvent = cleanupEvents[0];
    if (cleanupEvent?.type === "thread.archived") {
      expect(cleanupEvent.payload.worktreeCleanup?.path).toBe(canonicalWorktreePath);
      expect(cleanupEvent.payload.worktreeCleanup?.cwd).toBe("/tmp/project-archive");
    }
  });
});
