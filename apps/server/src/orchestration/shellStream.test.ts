import {
  CommandId,
  EventId,
  type OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import { filterArchivedShellSnapshot, toShellStreamEvent } from "./shellStream.ts";

describe("filterArchivedShellSnapshot", () => {
  it("keeps only archived threads and their projects", () => {
    const archivedProjectId = ProjectId.make("project-archived");
    const activeProjectId = ProjectId.make("project-active");
    const createdAt = "2026-08-03T00:00:00.000Z";
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
    };
    const makeProject = (id: ProjectId, title: string) => ({
      id,
      title,
      workspaceRoot: `/tmp/${id}`,
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    });
    const makeThread = (id: ThreadId, projectId: ProjectId, archivedAt: string | null) => ({
      id,
      projectId,
      title: String(id),
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      hasPendingQueuedTurn: false,
    });
    const snapshot = {
      snapshotSequence: 3,
      projects: [
        makeProject(archivedProjectId, "Archived"),
        makeProject(activeProjectId, "Active"),
      ],
      threads: [
        makeThread(ThreadId.make("thread-archived"), archivedProjectId, "2026-08-03T00:00:00.000Z"),
        makeThread(ThreadId.make("thread-active"), activeProjectId, null),
      ],
      updatedAt: createdAt,
    };

    const archived = filterArchivedShellSnapshot(snapshot);

    expect(archived.projects.map((project) => project.id)).toEqual([archivedProjectId]);
    expect(archived.threads.map((thread) => thread.id)).toEqual([ThreadId.make("thread-archived")]);
  });
});

describe("toShellStreamEvent", () => {
  it("removes every archived nested thread without reading the active shell", async () => {
    let activeShellReads = 0;
    const query = {
      getProjectShellById: () => Effect.die("Archive events do not read projects"),
      getThreadShellById: () => {
        activeShellReads += 1;
        return Effect.die("Archive events do not read the active shell");
      },
    } satisfies Pick<ProjectionSnapshotQueryShape, "getProjectShellById" | "getThreadShellById">;
    const archiveEvent = (threadId: ThreadId, sequence: number) =>
      ({
        sequence,
        eventId: EventId.make(`event-thread-archived-${threadId}`),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-08-03T00:00:00.000Z",
        commandId: CommandId.make("cmd-thread-archive-parent"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-thread-archive-parent"),
        metadata: {},
        type: "thread.archived",
        payload: {
          threadId,
          archivedAt: "2026-08-03T00:00:00.000Z",
          updatedAt: "2026-08-03T00:00:00.000Z",
        },
      }) satisfies Extract<OrchestrationEvent, { type: "thread.archived" }>;

    const events = await Effect.runPromise(
      Effect.all([
        toShellStreamEvent(query, archiveEvent(ThreadId.make("parent"), 1)),
        toShellStreamEvent(query, archiveEvent(ThreadId.make("child"), 2)),
      ]),
    );

    expect(activeShellReads).toBe(0);
    expect(events.every(Option.isSome)).toBe(true);
    expect(
      events
        .flatMap((event) => (Option.isSome(event) ? [event.value] : []))
        .map((event) => (event.kind === "thread-removed" ? event.threadId : null)),
    ).toEqual([ThreadId.make("parent"), ThreadId.make("child")]);
  });

  describe("activity-appended shell filtering", () => {
    const threadId = ThreadId.make("thread-stream-filter");
    const activityEvent = (kind: string, payload: unknown, sequence: number) =>
      ({
        sequence,
        eventId: EventId.make(`event-activity-${sequence}`),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-08-03T00:00:00.000Z",
        commandId: CommandId.make("cmd-activity"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-activity"),
        metadata: {},
        type: "thread.activity-appended",
        payload: {
          threadId,
          activity: {
            id: EventId.make(`activity-${sequence}`),
            tone: "tool",
            kind,
            summary: "Activity",
            payload,
            turnId: null,
            createdAt: "2026-08-03T00:00:00.000Z",
          },
        },
      }) as Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    const runWithReadCounter = async (
      events: ReadonlyArray<Extract<OrchestrationEvent, { type: "thread.activity-appended" }>>,
    ) => {
      let shellReads = 0;
      const query = {
        getProjectShellById: () => Effect.die("Activity events do not read projects"),
        getThreadShellById: () => {
          shellReads += 1;
          return Effect.succeed(Option.none());
        },
      } satisfies Pick<ProjectionSnapshotQueryShape, "getProjectShellById" | "getThreadShellById">;
      const results = await Effect.runPromise(
        Effect.all(events.map((event) => toShellStreamEvent(query, event))),
      );
      return { shellReads, results };
    };

    it("skips the shell re-read for activities that change no shell field", async () => {
      const { shellReads, results } = await runWithReadCounter([
        activityEvent("tool.updated", { detail: "running" }, 1),
        activityEvent("provider.approval.respond.failed", { detail: "boom" }, 2),
        activityEvent("task.started", { taskType: "plan" }, 3),
      ]);

      expect(shellReads).toBe(0);
      expect(results.every(Option.isNone)).toBe(true);
    });

    it("still re-reads the shell for approval, input, and task boundaries", async () => {
      const { shellReads, results } = await runWithReadCounter([
        activityEvent("approval.requested", { requestKind: "command" }, 4),
        activityEvent("user-input.requested", {}, 5),
        activityEvent("task.started", { taskType: "background-agent" }, 6),
        activityEvent("task.completed", {}, 7),
      ]);

      expect(shellReads).toBe(4);
      expect(results.every(Option.isNone)).toBe(true);
    });
  });
});
