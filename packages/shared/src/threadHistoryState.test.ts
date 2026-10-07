import { describe, expect, it } from "vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import {
  createHistoryPager,
  reduceHistoryPager,
  historyRetentionLimits,
  retainHistoryRows,
} from "./threadHistoryState.ts";

// Failure modes before implementation: obsolete replies resurrect reverted rows;
// global watermarks park forever; canceled requests leave loading sticky; unknown
// queued/late-turn messages are mistaken for excluded history; reconnect resets
// explicit depth; around-message reads skip intervening history; live growth
// silently turns a loaded-window floor into an unlimited retention policy.
const threadId = ThreadId.make("history-state");
const now = "2026-10-01T00:00:00.000Z";
function snapshot(
  turns = 10,
  sequence = 10,
  beforeCursor: string | null = "older",
): OrchestrationThreadDetailSnapshot {
  return {
    snapshotSequence: sequence,
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "History",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      session: null,
      latestTurn: null,
      messages: Array.from({ length: turns }, (_, i) => ({
        id: MessageId.make(`user-${i}`),
        role: "user" as const,
        text: "User",
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      })),
      activities: [],
      checkpoints: [],
      proposedPlans: [],
    },
    page: {
      snapshotSequence: sequence,
      threadSequence: sequence,
      hasMore: beforeCursor !== null,
      beforeCursor,
      windowStart: { sequence: 5, rowId: 5 },
    },
  };
}
function event(sequence: number, id: string): OrchestrationEvent {
  return {
    eventId: EventId.make(`event-${sequence}`),
    sequence,
    type: "thread.message-sent",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      messageId: MessageId.make(id),
      role: "assistant",
      turnId: TurnId.make("queued-interleaved-turn"),
      text: "delta",
      streaming: true,
      createdAt: now,
      updatedAt: now,
    },
  };
}
describe("shared history transitions", () => {
  it("waits only for the page's detail watermark and fences obsolete requests", () => {
    let state = createHistoryPager(snapshot());
    state = reduceHistoryPager(state, { type: "request", kind: "older" }).state;
    const requestId = state.pending!.id;
    const page = {
      ...snapshot(20, 100, "earlier"),
      page: { ...snapshot().page!, snapshotSequence: 100, threadSequence: 12 },
    };
    let transition = reduceHistoryPager(state, { type: "page", snapshot: page, requestId });
    expect(transition.effects).toEqual([]);
    expect(transition.state.pending).not.toBeNull();
    transition = reduceHistoryPager(transition.state, { type: "synchronized", sequence: 12 });
    expect(transition.effects[0]?.type).toBe("merge-page");
    expect(transition.state.pending).toBeNull();
    state = reduceHistoryPager(state, { type: "invalidate", reload: true }).state;
    expect(reduceHistoryPager(state, { type: "page", snapshot: page, requestId }).effects).toEqual(
      [],
    );
  });
  it("cancels loading and retains the requested depth through a replacement snapshot", () => {
    let state = createHistoryPager(snapshot(30));
    state = reduceHistoryPager(state, { type: "request", kind: "older" }).state;
    state = reduceHistoryPager(state, { type: "invalidate", reload: true }).state;
    expect(state.pending).toBeNull();
    expect(state.requestedTurns).toBe(30);
    state = reduceHistoryPager(state, { type: "snapshot", snapshot: snapshot(10) }).state;
    expect(state.requestedTurns).toBe(30);
    expect(state.loadedTurns).toBe(10);
  });
  it("uses message origin, not latest/active turn guesses, for interleaved queued replies", () => {
    const state = createHistoryPager(snapshot());
    const newer = reduceHistoryPager(state, {
      type: "event",
      event: event(11, "queued-reply"),
      messageOrigin: { sequence: 11, rowId: 11 },
      loadedMessageIds: [],
    });
    expect(newer.effects.some((e) => e.type === "apply-event")).toBe(true);
    const legacy = reduceHistoryPager(state, {
      type: "event",
      event: event(11, "legacy-reply"),
      messageOrigin: { sequence: 1, rowId: 1 },
      loadedMessageIds: [],
    });
    expect(legacy.effects.some((e) => e.type === "apply-event")).toBe(false);
    const unknown = reduceHistoryPager(state, {
      type: "event",
      event: event(11, "unknown-origin"),
      loadedMessageIds: [],
    });
    expect(unknown.effects.some((e) => e.type === "apply-event")).toBe(false);
    expect(unknown.effects.some((e) => e.type === "reload")).toBe(true);
  });
  it("does not advance the contiguous cursor for an around-message page", () => {
    let state = createHistoryPager(snapshot());
    state = reduceHistoryPager(state, { type: "request", kind: "around" }).state;
    const result = reduceHistoryPager(state, {
      type: "page",
      snapshot: snapshot(2, 10, null),
      requestId: state.pending!.id,
    });
    expect(result.state.page?.beforeCursor).toBe("older");
    expect(result.state.page?.hasMore).toBe(true);
    expect(result.effects[0]?.type).toBe("merge-page");
  });
  it("keeps a finite retention floor for explicitly loaded history", () => {
    const thread = {
      ...snapshot().thread,
      activities: Array.from({ length: 700 }, (_, i) => ({
        id: EventId.make(`a-${i}`),
        kind: "runtime.info",
        tone: "info" as const,
        summary: "Activity",
        turnId: null,
        payload: {},
        createdAt: now,
      })),
    };
    const limits = historyRetentionLimits(thread);
    expect(limits.activities).toBe(700);
    expect(
      retainHistoryRows(
        Array.from({ length: 5000 }, (_, i) => i),
        limits.activities,
      ),
    ).toHaveLength(700);
  });
});
