import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  QueuedTurnId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const started = "2026-09-09T00:00:00.000Z";
const finished = "2026-09-09T00:01:00.000Z";
const parentId = ThreadId.make("parent");
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);

function thread(
  id: string,
  child = false,
): { -readonly [K in keyof OrchestrationThread]: OrchestrationThread[K] } {
  const turnId = TurnId.make(`turn-${id}`);
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project"),
    parentThreadId: child ? parentId : null,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("copilot"), model: "test-model" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: started,
    updatedAt: started,
    archivedAt: null,
    deletedAt: null,
    session: null,
    latestTurn: child
      ? {
          turnId,
          state: "completed",
          requestedAt: started,
          startedAt: started,
          completedAt: finished,
          assistantMessageId: MessageId.make(`result-${id}`),
        }
      : null,
    messages: child
      ? [
          {
            id: MessageId.make(`result-${id}`),
            role: "assistant",
            text: "Result evidence",
            turnId,
            streaming: false,
            createdAt: started,
            updatedAt: finished,
          },
        ]
      : [],
    proposedPlans: [],
    queuedTurns: [],
    checkpoints: [],
    activities: child
      ? [
          {
            id: EventId.make(`completion-${id}`),
            kind: "insights.turn.completed",
            tone: "info",
            summary: "Turn completed",
            payload: { state: "completed" },
            turnId,
            createdAt: finished,
          },
        ]
      : [],
    ...(child
      ? {
          nudging: {
            delegation: {
              assignmentId: MessageId.make(`assignment-${id}`),
              followUp: "automatic",
              completedAt: null,
            },
          },
        }
      : {}),
  };
}

function model(...children: OrchestrationThread[]): OrchestrationReadModel {
  return { ...createEmptyReadModel(started), threads: [thread("parent"), ...children] };
}

function withParent(
  state: OrchestrationReadModel,
  patch: Partial<OrchestrationThread>,
): OrchestrationReadModel {
  return {
    ...state,
    threads: state.threads.map((entry) => (entry.id === parentId ? { ...entry, ...patch } : entry)),
  };
}

function finish(id: string): Extract<OrchestrationCommand, { type: "thread.turn.diff.complete" }> {
  return {
    type: "thread.turn.diff.complete",
    commandId: CommandId.make(`finish-${id}`),
    threadId: ThreadId.make(id),
    turnId: TurnId.make(`turn-${id}`),
    completedAt: finished,
    createdAt: finished,
    checkpointRef: CheckpointRef.make(`checkpoint-${id}`),
    status: "ready",
    files: [],
    agentTouchedPaths: [],
    turnFiles: [],
    checkpointTurnCount: 1,
  };
}

async function apply(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  const result = await Effect.runPromise(decideOrchestrationCommand({ readModel, command }));
  const events = (Array.isArray(result) ? result : [result]).map((event, index) =>
    decodeEvent({
      ...event,
      sequence: readModel.snapshotSequence + index + 1,
    }),
  );
  for (const event of events) {
    readModel = await Effect.runPromise(projectEvent(readModel, event));
  }
  return { readModel, events };
}

function report(
  id: string,
  kind: "progress" | "decision-needed" | "important-update",
): Extract<OrchestrationCommand, { type: "thread.child.report" }> {
  return {
    type: "thread.child.report",
    commandId: CommandId.make(`report-${id}-${kind}`),
    threadId: ThreadId.make(id),
    reportId: kind,
    kind,
    summary: "Need a decision",
    createdAt: finished,
  };
}

describe("child nudging", () => {
  it("bounds a batch at 32 reports and rejects edits to generated prompts", async () => {
    let state = model(thread("child", true));
    for (let index = 0; index < 33; index++) {
      state = (
        await apply(state, {
          ...report("child", "important-update"),
          commandId: CommandId.make(`report-${index}`),
          reportId: `report-${index}`,
        })
      ).readModel;
    }
    const queue = state.threads[0]!.queuedTurns!;
    expect(queue).toHaveLength(2);
    expect(
      queue.map((turn) => (turn.origin?.kind === "child-nudge" ? turn.origin.updates.length : 0)),
    ).toEqual([32, 1]);
    await expect(
      apply(state, {
        type: "thread.queued-turn.update",
        commandId: CommandId.make("edit-generated"),
        threadId: parentId,
        queuedTurnId: queue[0]!.id,
        text: "Changed",
        updatedAt: finished,
      }),
    ).rejects.toThrow("cannot be edited");
  });

  it("batches five completed assignments and retains result attribution", async () => {
    let state = model(...Array.from({ length: 5 }, (_, index) => thread(`child-${index}`, true)));
    for (let index = 0; index < 5; index++) {
      state = (await apply(state, finish(`child-${index}`))).readModel;
    }
    const queue = state.threads[0]!.queuedTurns!;
    expect(queue).toHaveLength(1);
    expect(queue[0]!.origin).toMatchObject({
      kind: "child-nudge",
      updates: Array.from({ length: 5 }, (_, index) => ({
        childThreadId: `child-${index}`,
        assignmentId: `assignment-child-${index}`,
        sourceMessageId: `result-child-${index}`,
        kind: "result-available",
      })),
    });
    expect(queue[0]!.message.text).toContain("not proof of task success");
    const retry = await apply(state, finish("child-0"));
    expect(retry.readModel.threads[0]!.queuedTurns).toEqual(queue);
  });

  it.each(["progress", "decision-needed", "important-update"] as const)(
    "records %s and only wakes for actionable reports",
    async (kind) => {
      const { readModel, events } = await apply(
        model(thread("child", true)),
        report("child", kind),
      );
      expect(events.some((event) => event.type === "thread.child-lifecycle-notified")).toBe(true);
      expect(readModel.threads[0]!.queuedTurns).toHaveLength(kind === "progress" ? 0 : 1);
    },
  );

  it("records notify-only results without waking and leaves historical children unchanged", async () => {
    const child = thread("child", true);
    child.nudging = { delegation: { ...child.nudging!.delegation!, followUp: "notify-only" } };
    const notified = await apply(model(child), finish("child"));
    expect(notified.readModel.threads[0]!.queuedTurns).toEqual([]);
    expect(notified.events.some((event) => event.type === "thread.child-lifecycle-notified")).toBe(
      true,
    );
    const legacy = thread("legacy", true);
    delete legacy.nudging;
    expect((await apply(model(legacy), finish("legacy"))).events).toHaveLength(1);
  });

  it("pauses on Stop, rejects dispatch, and resumes only explicitly", async () => {
    let state = (await apply(model(thread("child", true)), finish("child"))).readModel;
    state = (
      await apply(state, {
        type: "thread.session.stop",
        commandId: CommandId.make("stop"),
        threadId: parentId,
        createdAt: finished,
      })
    ).readModel;
    const dispatch: OrchestrationCommand = {
      type: "thread.queued-turn.dispatch",
      commandId: CommandId.make("dispatch"),
      threadId: parentId,
      queuedTurnId: state.threads[0]!.queuedTurns![0]!.id,
      dispatchedAt: finished,
    };
    await expect(apply(state, dispatch)).rejects.toThrow("paused");
    state = (
      await apply(state, {
        type: "thread.meta.update",
        commandId: CommandId.make("resume"),
        threadId: parentId,
        childFollowUpPaused: false,
      })
    ).readModel;
    state = withParent(state, { runtimeMode: "full-access" });
    const delivered = await apply(state, dispatch);
    expect(delivered.readModel.threads[0]!.queuedTurns).toEqual([]);
    expect(
      delivered.events.find((event) => event.type === "thread.turn-start-requested"),
    ).toMatchObject({ payload: { runtimeMode: "full-access" } });
  });

  it.each(["thread.turn.interrupt", "thread.session.stop"] as const)(
    "%s does not emit redundant pause metadata",
    async (type) => {
      const command = {
        type,
        commandId: CommandId.make("pause"),
        threadId: parentId,
        createdAt: finished,
      };
      const paused = await apply(model(), command);
      expect(paused.events).toHaveLength(2);
      expect(paused.readModel.threads[0]!.nudging?.paused).toBe(true);
      const repeated = await apply(paused.readModel, {
        ...command,
        commandId: CommandId.make("pause-again"),
      });
      expect(repeated.events).toHaveLength(1);
      expect(repeated.events[0]!.type).toBe(
        type === "thread.turn.interrupt"
          ? "thread.turn-interrupt-requested"
          : "thread.session-stop-requested",
      );
    },
  );

  it.each(["archived", "deleted", "approval", "input"] as const)(
    "does not dispatch to a parent that is %s",
    async (reason) => {
      let state = (await apply(model(thread("child", true)), finish("child"))).readModel;
      const parent = state.threads[0]!;
      if (reason === "archived") state = withParent(state, { archivedAt: finished });
      if (reason === "deleted") state = withParent(state, { deletedAt: finished });
      if (reason === "approval" || reason === "input")
        state = withParent(state, {
          activities: [
            {
              id: EventId.make(reason),
              kind: reason === "approval" ? "approval.requested" : "user-input.requested",
              tone: "approval",
              summary: "Pending",
              payload: { requestId: reason },
              turnId: null,
              createdAt: finished,
            },
          ],
        });
      await expect(
        apply(state, {
          type: "thread.queued-turn.dispatch",
          commandId: CommandId.make(`dispatch-${reason}`),
          threadId: parentId,
          queuedTurnId: parent.queuedTurns![0]!.id,
          dispatchedAt: finished,
        }),
      ).rejects.toThrow();
    },
  );

  it("preserves intervening user messages instead of merging across them", async () => {
    let state = (await apply(model(thread("one", true), thread("two", true)), finish("one")))
      .readModel;
    const first = state.threads[0]!.queuedTurns![0]!;
    state = withParent(state, {
      queuedTurns: [
        first,
        {
          ...first,
          id: QueuedTurnId.make("user"),
          origin: undefined,
          message: {
            ...first.message,
            messageId: MessageId.make("user"),
            text: "My next instruction",
          },
        },
      ],
    });
    state = (await apply(state, finish("two"))).readModel;
    expect(state.threads[0]!.queuedTurns).toHaveLength(3);
    expect(state.threads[0]!.queuedTurns![1]!.message.text).toBe("My next instruction");
  });

  it("does not finish an assignment at a handoff or for a stale turn", async () => {
    const child = thread("child", true);
    const queued = (await apply(model(thread("other", true)), finish("other"))).readModel
      .threads[0]!.queuedTurns!;
    child.queuedTurns = queued;
    expect((await apply(model(child), finish("child"))).events).toHaveLength(1);
    child.queuedTurns = [];
    child.latestTurn = { ...child.latestTurn!, turnId: TurnId.make("new-turn") };
    expect((await apply(model(child), finish("child"))).events).toHaveLength(1);
  });

  it("reports missing completion evidence as unconfirmed, not successful", async () => {
    const child = thread("child", true);
    child.activities = [];
    const result = await apply(model(child), finish("child"));
    expect(result.readModel.threads[0]!.queuedTurns![0]!.origin).toMatchObject({
      kind: "child-nudge",
      updates: [{ kind: "blocked", summary: expect.stringContaining("unconfirmed") }],
    });
  });

  it("keeps speculative checkpoints pending until authoritative completion", async () => {
    const child = thread("child", true);
    const completion = child.activities[0]!;
    child.activities = [];
    child.latestTurn = { ...child.latestTurn!, state: "running", completedAt: null };
    const speculative = await apply(model(child), {
      ...finish("child"),
      commandId: CommandId.make("speculative"),
      status: "speculative",
    });
    expect(speculative.events.map((event) => event.type)).toEqual(["thread.turn-diff-completed"]);
    expect(speculative.readModel.threads[1]!.nudging?.delegation?.completedAt).toBeNull();
    expect(speculative.readModel.threads[0]!.queuedTurns).toHaveLength(0);
    const completed = await apply(speculative.readModel, {
      type: "thread.activity.append",
      commandId: CommandId.make("completion-evidence"),
      threadId: child.id,
      activity: completion,
      createdAt: finished,
    });
    const result = await apply(completed.readModel, finish("child"));
    expect(result.readModel.threads[1]!.nudging?.delegation?.completedAt).toBe(finished);
    expect(result.readModel.threads[0]!.queuedTurns![0]!.origin).toMatchObject({
      kind: "child-nudge",
      updates: [{ kind: "result-available" }],
    });
  });

  it("notifies when provider startup fails and does not produce a second terminal report", async () => {
    const child = thread("child", true);
    const failed: OrchestrationCommand = {
      type: "thread.activity.append",
      commandId: CommandId.make("start-failed"),
      threadId: child.id,
      createdAt: finished,
      activity: {
        id: EventId.make("failure"),
        kind: "provider.turn.start.failed",
        tone: "error",
        summary: "Provider unavailable",
        payload: {},
        turnId: null,
        createdAt: finished,
      },
    };
    const result = await apply(model(child), failed);
    expect(result.readModel.threads[0]!.queuedTurns![0]!.origin).toMatchObject({
      kind: "child-nudge",
      updates: [{ kind: "failed" }],
    });
    expect((await apply(result.readModel, finish("child"))).events).toHaveLength(1);
  });

  it("accepts a report from the active execution and propagates its dispatch", async () => {
    const child = thread("child", true);
    child.nudging = {
      delegation: { ...child.nudging!.delegation!, dispatchId: "dispatch-1" },
    };
    const { readModel, events } = await apply(model(child), {
      ...report("child", "decision-needed"),
      dispatchId: "dispatch-1",
    });
    expect(events.some((event) => event.type === "thread.child-lifecycle-notified")).toBe(true);
    expect(readModel.threads[0]!.queuedTurns).toHaveLength(1);
    expect(readModel.threads[0]!.queuedTurns![0]!.origin).toMatchObject({
      kind: "child-nudge",
      updates: [{ assignmentId: "assignment-child", dispatchId: "dispatch-1" }],
    });
  });

  it("records a superseded execution report as stale without waking the parent", async () => {
    const child = thread("child", true);
    child.nudging = {
      delegation: { ...child.nudging!.delegation!, dispatchId: "dispatch-2" },
    };
    const { readModel, events } = await apply(model(child), {
      ...report("child", "decision-needed"),
      dispatchId: "dispatch-1",
    });
    expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    expect(events[0]).toMatchObject({
      payload: {
        activity: { payload: { dispatchVerdict: "stale", dispatchId: "dispatch-1" } },
      },
    });
    expect(readModel.threads[0]!.queuedTurns).toEqual([]);
    expect(readModel.threads[1]!.nudging?.delegation?.completedAt).toBeNull();
  });

  it("records an unfenced-proof report on a fenced delegation as stale", async () => {
    const child = thread("child", true);
    child.nudging = {
      delegation: { ...child.nudging!.delegation!, dispatchId: "dispatch-1" },
    };
    const { readModel, events } = await apply(model(child), report("child", "important-update"));
    expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    expect(events[0]).toMatchObject({
      payload: { activity: { payload: { dispatchVerdict: "stale" } } },
    });
    expect(readModel.threads[0]!.queuedTurns).toEqual([]);
  });

  it("acknowledges reports on completed assignments without a second wake", async () => {
    let state = (await apply(model(thread("child", true)), finish("child"))).readModel;
    expect(state.threads[0]!.queuedTurns).toHaveLength(1);
    const { readModel, events } = await apply(state, {
      ...report("child", "important-update"),
      commandId: CommandId.make("report-after-complete"),
      reportId: "after-complete",
    });
    expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    expect(events[0]).toMatchObject({
      payload: { activity: { payload: { dispatchVerdict: "already-recorded" } } },
    });
    expect(readModel.threads[0]!.queuedTurns).toHaveLength(1);
  });
});
