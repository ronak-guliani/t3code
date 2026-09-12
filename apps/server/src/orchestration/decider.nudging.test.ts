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
  it("collects routine results for a fixed two seconds without extending the deadline", async () => {
    let state = model(thread("a", true), thread("b", true));
    state = (await apply(state, finish("a"))).readModel;
    state = (await apply(state, { ...finish("b"), createdAt: "2026-09-09T00:01:01.000Z" }))
      .readModel;
    const queued = state.threads[0]!.queuedTurns![0]!;
    expect(queued.origin).toMatchObject({ collectUntil: "2026-09-09T00:01:02.000Z" });
    const dispatch = {
      type: "thread.queued-turn.dispatch" as const,
      commandId: CommandId.make("collect"),
      threadId: parentId,
      queuedTurnId: queued.id,
      dispatchedAt: "2026-09-09T00:01:01.999Z",
    };
    await expect(apply(state, dispatch)).rejects.toThrow("Collecting");
    const delivered = await apply(state, { ...dispatch, dispatchedAt: "2026-09-09T00:01:02.000Z" });
    expect(
      delivered.events.filter((event) => event.type === "thread.turn-start-requested"),
    ).toHaveLength(1);
    expect(delivered.readModel.threads[0]!.messages[0]!.origin).toMatchObject({
      updates: [{ childThreadId: "a" }, { childThreadId: "b" }],
    });
  });

  it.each(["any", "all"] as const)(
    "supports a durable %s wait and satisfies it once",
    async (mode) => {
      let state = model(thread("a", true), thread("b", true));
      state = (
        await apply(state, {
          type: "thread.meta.update",
          commandId: CommandId.make("wait"),
          threadId: parentId,
          childWait: {
            mode,
            assignments: ["a", "b"].map((id) => ({
              childThreadId: ThreadId.make(id),
              assignmentId: MessageId.make(`assignment-${id}`),
            })),
          },
        })
      ).readModel;
      state = (await apply(state, finish("a"))).readModel;
      const dispatch = {
        type: "thread.queued-turn.dispatch" as const,
        commandId: CommandId.make("wait-dispatch"),
        threadId: parentId,
        queuedTurnId: state.threads[0]!.queuedTurns![0]!.id,
        dispatchedAt: "2026-09-09T00:01:02.000Z",
      };
      if (mode === "all") {
        await expect(apply(state, dispatch)).rejects.toThrow("Waiting for 1 child");
        state = (await apply(state, finish("b"))).readModel;
      }
      const delivered = await apply(state, dispatch);
      expect(delivered.readModel.threads[0]!.nudging?.wait?.satisfiedAt).toBe(
        dispatch.dispatchedAt,
      );
      const waitEvent = delivered.events.find(
        (event) => event.type === "thread.meta-updated" && event.payload.nudging?.wait?.satisfiedAt,
      );
      expect(delivered.events.some((event) => event.eventId === waitEvent?.causationEventId)).toBe(
        true,
      );
    },
  );

  it("escalates failures during an all wait without counting them as successful results", async () => {
    const failedChild = thread("a", true);
    failedChild.activities = [{ ...failedChild.activities[0]!, payload: { state: "failed" } }];
    let state = (
      await apply(model(failedChild, thread("b", true)), {
        type: "thread.meta.update",
        commandId: CommandId.make("wait"),
        threadId: parentId,
        childWait: {
          mode: "all",
          assignments: ["a", "b"].map((id) => ({
            childThreadId: ThreadId.make(id),
            assignmentId: MessageId.make(`assignment-${id}`),
          })),
        },
      })
    ).readModel;
    state = (await apply(state, finish("a"))).readModel;
    const delivered = await apply(state, {
      type: "thread.queued-turn.dispatch",
      commandId: CommandId.make("failure-dispatch"),
      threadId: parentId,
      queuedTurnId: state.threads[0]!.queuedTurns![0]!.id,
      dispatchedAt: finished,
    });
    expect(delivered.readModel.threads[0]!.nudging?.wait).toMatchObject({
      assignments: [{ outcome: "failed" }, {}],
    });
    expect(delivered.readModel.threads[0]!.nudging?.wait?.satisfiedAt).toBeUndefined();
  });

  it("holds routine reports under decision-only policy but dispatches a structured decision", async () => {
    let state = withParent(model(thread("a", true)), {
      nudging: { wait: { mode: "decisions-only", assignments: [] } },
    });
    state = (await apply(state, report("a", "important-update"))).readModel;
    const dispatch = {
      type: "thread.queued-turn.dispatch" as const,
      commandId: CommandId.make("decision-dispatch"),
      threadId: parentId,
      queuedTurnId: state.threads[0]!.queuedTurns![0]!.id,
      dispatchedAt: finished,
    };
    await expect(apply(state, dispatch)).rejects.toThrow("Only decisions");
    state = (
      await apply(state, {
        ...report("a", "decision-needed"),
        assignmentId: MessageId.make("assignment-a"),
        decision: { question: "Which approach?", options: ["A", "B"], recommendation: "A" },
        canContinue: false,
      })
    ).readModel;
    expect(state.threads[1]!.nudging?.delegation?.decision?.decision?.question).toBe(
      "Which approach?",
    );
    const delivered = await apply(state, dispatch);
    expect(delivered.readModel.threads[0]!.messages[0]!.text).toContain(
      "Question: Which approach?",
    );
    expect(delivered.readModel.threads[1]!.nudging?.delegation?.decision).not.toBeNull();
  });

  it("resolves decisions atomically with child responses and filters stale reports from mixed deliveries", async () => {
    let state = (await apply(model(thread("a", true)), report("a", "decision-needed"))).readModel;
    state = (await apply(state, report("a", "important-update"))).readModel;
    const decision = state.threads[1]!.nudging!.delegation!.decision!;
    const response: OrchestrationCommand = {
      type: "thread.queued-turn.create",
      commandId: CommandId.make("answer"),
      threadId: ThreadId.make("a"),
      queuedTurnId: QueuedTurnId.make("answer"),
      assignmentId: decision.assignmentId,
      respondToReportId: decision.id,
      message: {
        messageId: MessageId.make("answer"),
        role: "user",
        text: "Use A",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: finished,
    };
    state = (await apply(state, response)).readModel;
    expect(state.threads[1]!.nudging?.delegation?.decision).toBeNull();
    expect(state.threads[1]!.queuedTurns?.[0]?.message.text).toBe("Use A");
    await expect(
      apply(state, { ...response, queuedTurnId: QueuedTurnId.make("duplicate") }),
    ).rejects.toThrow("no longer current");
    const delivered = await apply(state, {
      type: "thread.queued-turn.dispatch",
      commandId: CommandId.make("mixed-dispatch"),
      threadId: parentId,
      queuedTurnId: state.threads[0]!.queuedTurns![0]!.id,
      dispatchedAt: "2026-09-09T00:01:02.000Z",
    });
    expect(delivered.readModel.threads[0]!.messages[0]!.origin).toMatchObject({
      updates: [{ kind: "important-update" }],
    });
    const responseDelivered = await apply(state, {
      type: "thread.queued-turn.dispatch",
      commandId: CommandId.make("answer-dispatch"),
      threadId: ThreadId.make("a"),
      queuedTurnId: QueuedTurnId.make("answer"),
      dispatchedAt: finished,
    });
    expect(responseDelivered.readModel.threads[1]!.nudging?.delegation?.pendingResponse).toBeNull();
  });

  it("does not finish an assignment with an unresolved decision", async () => {
    const state = (await apply(model(thread("a", true)), report("a", "decision-needed"))).readModel;
    const finishedState = (await apply(state, finish("a"))).readModel;
    expect(finishedState.threads[1]!.nudging?.delegation?.completedAt).toBeNull();
  });

  it("restores the unresolved question when an undelivered answer is deleted", async () => {
    let state = (await apply(model(thread("a", true)), report("a", "decision-needed"))).readModel;
    const decision = state.threads[1]!.nudging!.delegation!.decision!;
    state = (
      await apply(state, {
        type: "thread.queued-turn.create",
        commandId: CommandId.make("answer"),
        threadId: ThreadId.make("a"),
        queuedTurnId: QueuedTurnId.make("answer"),
        assignmentId: decision.assignmentId,
        respondToReportId: decision.id,
        message: {
          messageId: MessageId.make("answer"),
          role: "user",
          text: "Use A",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: finished,
      })
    ).readModel;
    expect(state.threads[1]!.nudging?.delegation?.pendingResponse?.report).toEqual(decision);
    state = (
      await apply(state, {
        type: "thread.queued-turn.fail",
        commandId: CommandId.make("answer-failed"),
        threadId: ThreadId.make("a"),
        queuedTurnId: QueuedTurnId.make("answer"),
        failureMessage: "Unavailable",
        failedAt: finished,
      })
    ).readModel;
    expect(state.threads[1]!.nudging?.delegation?.pendingResponse?.report).toEqual(decision);
    expect(state.threads[1]!.queuedTurns?.[0]?.failureMessage).toBe("Unavailable");
    state = (
      await apply(state, {
        type: "thread.queued-turn.delete",
        commandId: CommandId.make("delete-answer"),
        threadId: ThreadId.make("a"),
        queuedTurnId: QueuedTurnId.make("answer"),
        deletedAt: finished,
      })
    ).readModel;
    expect(state.threads[1]!.nudging?.delegation?.decision).toEqual(decision);
    expect(state.threads[1]!.nudging?.delegation?.pendingResponse).toBeNull();
  });

  it("reports cancellation when a queued assignment is removed", async () => {
    let state = (await apply(model(thread("a", true)), finish("a"))).readModel;
    state = (
      await apply(state, {
        type: "thread.queued-turn.create",
        commandId: CommandId.make("assign"),
        threadId: ThreadId.make("a"),
        queuedTurnId: QueuedTurnId.make("cancel-assignment"),
        assignment: { followUp: "automatic" },
        message: {
          messageId: MessageId.make("assignment-b"),
          role: "user",
          text: "New work",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: finished,
      })
    ).readModel;
    state = (
      await apply(state, {
        type: "thread.queued-turn.delete",
        commandId: CommandId.make("cancel"),
        threadId: ThreadId.make("a"),
        queuedTurnId: QueuedTurnId.make("cancel-assignment"),
        deletedAt: finished,
      })
    ).readModel;
    expect(state.threads[1]!.nudging?.delegation).toMatchObject({
      outcome: "blocked",
      completedAt: finished,
    });
    expect(state.threads[0]!.queuedTurns?.[0]?.origin).toMatchObject({
      updates: [
        { assignmentId: "assignment-a" },
        { assignmentId: "assignment-b", kind: "blocked" },
      ],
    });
  });

  it("drops queued follow-up from a detached child without starting the former parent", async () => {
    let state = (await apply(model(thread("a", true)), report("a", "important-update"))).readModel;
    state = {
      ...state,
      threads: state.threads.map((entry) =>
        entry.id === ThreadId.make("a") ? { ...entry, parentThreadId: null } : entry,
      ),
    };
    const delivered = await apply(state, {
      type: "thread.queued-turn.dispatch",
      commandId: CommandId.make("detached-dispatch"),
      threadId: parentId,
      queuedTurnId: state.threads[0]!.queuedTurns![0]!.id,
      dispatchedAt: finished,
    });
    expect(delivered.readModel.threads[0]!.messages).toEqual([]);
    expect(delivered.readModel.threads[0]!.queuedTurns).toEqual([]);
  });

  it("reuses a finished child with a new assignment and rejects old or uncorrelated reports", async () => {
    let state = (await apply(model(thread("a", true)), finish("a"))).readModel;
    const assign: OrchestrationCommand = {
      type: "thread.queued-turn.create",
      commandId: CommandId.make("assign"),
      threadId: ThreadId.make("a"),
      queuedTurnId: QueuedTurnId.make("assignment-b"),
      assignment: { followUp: "automatic" },
      message: {
        messageId: MessageId.make("assignment-b"),
        role: "user",
        text: "Revise the result",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-09-09T00:02:00.000Z",
    };
    state = (await apply(state, assign)).readModel;
    expect(state.threads[1]!.nudging?.delegation).toMatchObject({
      assignmentId: "assignment-b",
      completedAt: null,
      decision: null,
    });
    await expect(
      apply(state, { ...report("a", "progress"), assignmentId: MessageId.make("assignment-a") }),
    ).rejects.toThrow("does not match");
    await expect(apply(state, report("a", "progress"))).rejects.toThrow("does not match");
    await expect(
      apply(state, { ...assign, queuedTurnId: QueuedTurnId.make("overlap") }),
    ).rejects.toThrow("Finish the current assignment");
    const oldCompletion = await apply(state, finish("a"));
    expect(oldCompletion.readModel.threads[1]!.nudging?.delegation?.completedAt).toBeNull();
    await expect(
      apply(state, { ...report("a", "progress"), assignmentId: MessageId.make("assignment-b") }),
    ).resolves.toBeDefined();
  });

  it("rejects empty, foreign, and forged-complete wait conditions", async () => {
    for (const childWait of [
      { mode: "all" as const, assignments: [] },
      {
        mode: "all" as const,
        assignments: [
          { childThreadId: ThreadId.make("other"), assignmentId: MessageId.make("other") },
        ],
      },
      { mode: "decisions-only" as const, assignments: [], satisfiedAt: finished },
    ]) {
      await expect(
        apply(model(), {
          type: "thread.meta.update",
          commandId: CommandId.make("invalid-wait"),
          threadId: parentId,
          childWait,
        }),
      ).rejects.toThrow();
    }
  });

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
      dispatchedAt: "2026-09-09T00:01:02.000Z",
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

  it("accepts a report from the authorized turn and propagates its dispatch", async () => {
    const child = thread("child", true);
    child.nudging = {
      delegation: {
        ...child.nudging!.delegation!,
        dispatchId: "dispatch-1",
        dispatchSequence: 1,
        dispatchTurnId: TurnId.make("turn-a"),
      },
    };
    const { readModel, events } = await apply(model(child), {
      ...report("child", "decision-needed"),
      originTurnId: TurnId.make("turn-a"),
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
      delegation: {
        ...child.nudging!.delegation!,
        dispatchId: "dispatch-2",
        dispatchSequence: 2,
        dispatchTurnId: TurnId.make("turn-b"),
      },
    };
    const { readModel, events } = await apply(model(child), {
      ...report("child", "decision-needed"),
      originTurnId: TurnId.make("turn-a"),
      dispatchId: "dispatch-1",
    });
    expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    expect(events[0]).toMatchObject({
      payload: {
        activity: { payload: { dispatchVerdict: "stale", dispatchId: "dispatch-1" } },
      },
    });
    expect(readModel.threads[0]!.queuedTurns).toEqual([]);
    expect(readModel.threads[1]!.nudging?.delegation).toMatchObject({
      dispatchId: "dispatch-2",
      dispatchTurnId: "turn-b",
      completedAt: null,
    });
  });

  it("fences stale decisions before decision-conflict validation", async () => {
    // The active execution established a decision; a superseded execution
    // then reports a conflicting decision. It must receive a `stale` verdict
    // and audit activity, never a decision-conflict rejection.
    const child = thread("child", true);
    const current = {
      ...report("child", "decision-needed"),
      commandId: CommandId.make("report-current"),
      reportId: "current",
      originTurnId: TurnId.make("turn-b"),
      dispatchId: "dispatch-2",
      decision: { question: "Current?" },
    };
    let state = model({
      ...child,
      nudging: {
        delegation: {
          ...child.nudging!.delegation!,
          dispatchId: "dispatch-2",
          dispatchSequence: 2,
          dispatchTurnId: TurnId.make("turn-b"),
        },
      },
    });
    state = (await apply(state, current)).readModel;
    expect(state.threads[1]!.nudging?.delegation?.decision).toBeDefined();
    const { events } = await apply(state, {
      ...report("child", "decision-needed"),
      commandId: CommandId.make("report-stale-decision"),
      reportId: "stale-decision",
      originTurnId: TurnId.make("turn-a"),
      dispatchId: "dispatch-1",
      decision: { question: "Stale?" },
    });
    expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    expect(events[0]).toMatchObject({
      payload: { activity: { payload: { dispatchVerdict: "stale" } } },
    });
  });

  it("attributes the report audit to the reporting execution turn", async () => {
    const child = thread("child", true);
    child.session = {
      status: "running",
      activeTurnId: TurnId.make("turn-b"),
      updatedAt: finished,
    } as OrchestrationThread["session"];
    child.nudging = {
      delegation: {
        ...child.nudging!.delegation!,
        dispatchId: "dispatch-2",
        dispatchSequence: 2,
        dispatchTurnId: TurnId.make("turn-b"),
      },
    };
    const { events } = await apply(model(child), {
      ...report("child", "progress"),
      commandId: CommandId.make("report-audit-turn"),
      reportId: "audit-turn",
      originTurnId: TurnId.make("turn-b"),
      dispatchId: "dispatch-2",
    });
    expect(events[0]).toMatchObject({
      payload: { activity: { turnId: "turn-b" } },
    });
  });

  it("keeps turn-absent failures diagnostic-only on fenced work", async () => {
    const child = thread("child", true);
    child.nudging = {
      delegation: {
        ...child.nudging!.delegation!,
        dispatchId: "dispatch-1",
        dispatchSequence: 1,
        dispatchTurnId: TurnId.make("turn-a"),
      },
    };
    const { readModel, events } = await apply(model(child), {
      type: "thread.activity.append",
      commandId: CommandId.make("unscoped-runtime-error"),
      threadId: ThreadId.make("child"),
      activity: {
        id: EventId.make("runtime-error-1"),
        kind: "runtime.error",
        tone: "info",
        summary: "boom",
        payload: {},
        turnId: null,
        createdAt: finished,
      },
      createdAt: finished,
    });
    expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    expect(readModel.threads[1]!.nudging?.delegation?.completedAt).toBeNull();
    expect(readModel.threads[0]!.queuedTurns).toEqual([]);
  });

  it("keeps progress history but requires proof for state-changing reports", async () => {
    const child = thread("child", true);
    child.nudging = {
      delegation: {
        ...child.nudging!.delegation!,
        dispatchId: "dispatch-1",
        dispatchSequence: 1,
        dispatchTurnId: TurnId.make("turn-a"),
      },
    };
    const progress = await apply(model(child), report("child", "progress"));
    expect(progress.events.some((event) => event.type === "thread.child-lifecycle-notified")).toBe(
      true,
    );
    expect(progress.readModel.threads[0]!.queuedTurns).toEqual([]);
    const actionable = await apply(model(child), report("child", "important-update"));
    expect(actionable.events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    expect(actionable.events[0]).toMatchObject({
      payload: { activity: { payload: { dispatchVerdict: "stale" } } },
    });
    expect(actionable.readModel.threads[0]!.queuedTurns).toEqual([]);
  });

  it("acknowledges exact duplicates on closed work but fences novel reports", async () => {
    let state = (await apply(model(thread("child", true)), finish("child"))).readModel;
    expect(state.threads[0]!.queuedTurns).toHaveLength(1);
    const { readModel, events } = await apply(state, {
      ...report("child", "important-update"),
      commandId: CommandId.make("report-after-complete"),
      reportId: "after-complete",
    });
    expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    expect(events[0]).toMatchObject({
      payload: { activity: { payload: { dispatchVerdict: "stale" } } },
    });
    expect(readModel.threads[0]!.queuedTurns).toHaveLength(1);
  });

  it("replays the recorded verdict for a retried report without a second wake", async () => {
    const first = {
      ...report("child", "important-update"),
      commandId: CommandId.make("report-once"),
      reportId: "once",
    };
    let state = (await apply(model(thread("child", true)), first)).readModel;
    expect(state.threads[0]!.queuedTurns).toHaveLength(1);
    state = (await apply(state, finish("child"))).readModel;
    expect(state.threads[1]!.nudging?.delegation?.completedAt).toBe(finished);
    // The auto-completion batches into the existing nudge turn instead of
    // waking the parent twice.
    expect(state.threads[0]!.queuedTurns).toHaveLength(1);
    const { readModel, events } = await apply(state, first);
    expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    expect(events[0]).toMatchObject({
      payload: { activity: { payload: { dispatchVerdict: "already-recorded" } } },
    });
    expect(readModel.threads[0]!.queuedTurns).toHaveLength(1);
  });

  it("binds the first execution turn and adopts legacy delegations into the fenced path", async () => {
    const child = thread("child", true);
    const bound = await apply(model(child), {
      type: "thread.session.set",
      commandId: CommandId.make("session-start-a"),
      threadId: child.id,
      session: {
        threadId: child.id,
        status: "running",
        providerName: "copilot",
        providerInstanceId: ProviderInstanceId.make("copilot"),
        runtimeMode: "approval-required",
        activeTurnId: TurnId.make("turn-a"),
        lastError: null,
        updatedAt: finished,
      },
      createdAt: finished,
    });
    const delegation = bound.readModel.threads[1]!.nudging?.delegation!;
    expect(delegation.dispatchTurnId).toBe("turn-a");
    expect(delegation.dispatchId).toBeDefined();
    expect(delegation.dispatchSequence).toBe(1);
    expect(delegation.completedAt).toBeNull();
  });

  it("mints a fresh dispatch when the bound turn is superseded, preserving replays", async () => {
    const child = thread("child", true);
    let state = (
      await apply(model(child), {
        type: "thread.session.set",
        commandId: CommandId.make("session-start-a"),
        threadId: child.id,
        session: {
          threadId: child.id,
          status: "running",
          providerName: "copilot",
          providerInstanceId: ProviderInstanceId.make("copilot"),
          runtimeMode: "approval-required",
          activeTurnId: TurnId.make("turn-a"),
          lastError: null,
          updatedAt: finished,
        },
        createdAt: finished,
      })
    ).readModel;
    const first = state.threads[1]!.nudging?.delegation!;
    state = (
      await apply(state, {
        type: "thread.session.set",
        commandId: CommandId.make("session-start-b"),
        threadId: child.id,
        session: {
          threadId: child.id,
          status: "running",
          providerName: "copilot",
          providerInstanceId: ProviderInstanceId.make("copilot"),
          runtimeMode: "approval-required",
          activeTurnId: TurnId.make("turn-b"),
          lastError: null,
          updatedAt: finished,
        },
        createdAt: finished,
      })
    ).readModel;
    const second = state.threads[1]!.nudging?.delegation!;
    expect(second.dispatchTurnId).toBe("turn-b");
    expect(second.dispatchId).not.toBe(first.dispatchId);
    expect(second.dispatchSequence).toBe((first.dispatchSequence ?? 0) + 1);
    const replayed = await apply(state, {
      type: "thread.session.set",
      commandId: CommandId.make("session-start-b-retry"),
      threadId: child.id,
      session: {
        threadId: child.id,
        status: "running",
        providerName: "copilot",
        providerInstanceId: ProviderInstanceId.make("copilot"),
        runtimeMode: "approval-required",
        activeTurnId: TurnId.make("turn-b"),
        lastError: null,
        updatedAt: finished,
      },
      createdAt: finished,
    });
    expect(replayed.readModel.threads[1]!.nudging?.delegation).toEqual(second);
  });

  it("fences a late report across a real bind-then-replace sequence", async () => {
    const child = thread("child", true);
    const sessionFor = (commandId: string, turn: string) =>
      ({
        type: "thread.session.set",
        commandId: CommandId.make(commandId),
        threadId: child.id,
        session: {
          threadId: child.id,
          status: "running",
          providerName: "copilot",
          providerInstanceId: ProviderInstanceId.make("copilot"),
          runtimeMode: "approval-required",
          activeTurnId: TurnId.make(turn),
          lastError: null,
          updatedAt: finished,
        },
        createdAt: finished,
      }) as Extract<OrchestrationCommand, { type: "thread.session.set" }>;
    let state = (await apply(model(child), sessionFor("session-a", "turn-a"))).readModel;
    const firstDispatch = state.threads[1]!.nudging?.delegation!.dispatchId!;
    state = (await apply(state, sessionFor("session-b", "turn-b"))).readModel;
    const secondDispatch = state.threads[1]!.nudging?.delegation!.dispatchId!;
    expect(secondDispatch).not.toBe(firstDispatch);
    const { readModel, events } = await apply(state, {
      ...report("child", "decision-needed"),
      commandId: CommandId.make("late-report-a"),
      reportId: "late-a",
      originTurnId: TurnId.make("turn-a"),
      dispatchId: firstDispatch,
    });
    expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    expect(events[0]).toMatchObject({
      payload: { activity: { payload: { dispatchVerdict: "stale" } } },
    });
    expect(readModel.threads[0]!.queuedTurns).toEqual([]);
    expect(readModel.threads[1]!.nudging?.delegation).toMatchObject({
      dispatchId: secondDispatch,
      dispatchTurnId: "turn-b",
      completedAt: null,
    });
  });

  it("keeps delayed checkpoints as diagnostics without completing the assignment", async () => {
    const child = thread("child", true);
    child.nudging = {
      delegation: {
        ...child.nudging!.delegation!,
        dispatchId: "dispatch-2",
        dispatchSequence: 2,
        dispatchTurnId: TurnId.make("turn-b"),
      },
    };
    child.latestTurn = { ...child.latestTurn!, turnId: TurnId.make("turn-a") };
    const delayedCheckpoint = {
      ...finish("child"),
      commandId: CommandId.make("finish-turn-a"),
      turnId: TurnId.make("turn-a"),
    };
    const { readModel, events } = await apply(model(child), delayedCheckpoint);
    expect(events.map((event) => event.type)).toEqual(["thread.turn-diff-completed"]);
    expect(readModel.threads[1]!.nudging?.delegation?.completedAt).toBeNull();
    expect(readModel.threads[0]!.queuedTurns).toEqual([]);
  });

  it("does not terminate the delegation on a delayed runtime failure", async () => {
    const child = thread("child", true);
    child.nudging = {
      delegation: {
        ...child.nudging!.delegation!,
        dispatchId: "dispatch-2",
        dispatchSequence: 2,
        dispatchTurnId: TurnId.make("turn-b"),
      },
    };
    const failed: OrchestrationCommand = {
      type: "thread.activity.append",
      commandId: CommandId.make("late-failure"),
      threadId: child.id,
      createdAt: finished,
      activity: {
        id: EventId.make("late-failure"),
        kind: "runtime.error",
        tone: "error",
        summary: "Late failure from a superseded turn",
        payload: {},
        turnId: TurnId.make("turn-a"),
        createdAt: finished,
      },
    };
    const { readModel, events } = await apply(model(child), failed);
    expect(events.some((event) => event.type === "thread.child-lifecycle-notified")).toBe(true);
    expect(readModel.threads[1]!.nudging?.delegation?.completedAt).toBeNull();
    expect(readModel.threads[0]!.queuedTurns).toEqual([]);
  });

  it("replaces executions explicitly with a compare-and-swap guard", async () => {
    const child = thread("child", true);
    child.nudging = {
      delegation: {
        ...child.nudging!.delegation!,
        dispatchId: "dispatch-1",
        dispatchSequence: 1,
        dispatchTurnId: TurnId.make("turn-a"),
      },
    };
    const state = model(child);
    await expect(
      apply(state, {
        type: "thread.dispatch.replace",
        commandId: CommandId.make("replace-wrong"),
        threadId: child.id,
        expectedDispatchId: "dispatch-9",
        createdAt: finished,
      }),
    ).rejects.toThrow("changed since this replacement was prepared");
    const { readModel } = await apply(state, {
      type: "thread.dispatch.replace",
      commandId: CommandId.make("replace-ok"),
      threadId: child.id,
      expectedDispatchId: "dispatch-1",
      createdAt: finished,
    });
    const delegation = readModel.threads[1]!.nudging?.delegation!;
    expect(delegation.dispatchId).not.toBe("dispatch-1");
    expect(delegation.dispatchSequence).toBe(2);
    expect(delegation.dispatchTurnId).toBeNull();
    expect(delegation.assignmentId).toBe("assignment-child");
  });

  it("keeps exact legacy keys for pre-fence reports", async () => {
    const { readModel, events } = await apply(
      model(thread("child", true)),
      report("child", "decision-needed"),
    );
    expect(events.some((event) => event.type === "thread.child-lifecycle-notified")).toBe(true);
    expect(readModel.threads[0]!.queuedTurns![0]!.origin).toMatchObject({
      kind: "child-nudge",
      updates: [{ id: "report:child:assignment-child:decision-needed" }],
    });
  });
});
