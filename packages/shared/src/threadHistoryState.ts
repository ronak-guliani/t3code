import type {
  OrchestrationEvent,
  OrchestrationMessageOrigin,
  OrchestrationThreadDetailPage,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { encodeBase64Url } from "effect/Encoding";

export interface HistoryRetentionLimits {
  messages: number;
  activities: number;
  checkpoints: number;
  proposedPlans: number;
}
export const DEFAULT_HISTORY_RETENTION: Readonly<HistoryRetentionLimits> = Object.freeze({
  messages: 2000,
  activities: 500,
  checkpoints: 500,
  proposedPlans: 200,
});
export function historyRetentionLimits(thread: {
  messages: { length: number };
  activities: { length: number };
  checkpoints: { length: number };
  proposedPlans: { length: number };
}): HistoryRetentionLimits {
  return {
    messages: Math.max(DEFAULT_HISTORY_RETENTION.messages, thread.messages.length),
    activities: Math.max(DEFAULT_HISTORY_RETENTION.activities, thread.activities.length),
    checkpoints: Math.max(DEFAULT_HISTORY_RETENTION.checkpoints, thread.checkpoints.length),
    proposedPlans: Math.max(DEFAULT_HISTORY_RETENTION.proposedPlans, thread.proposedPlans.length),
  };
}
export function retainHistoryRows<T>(rows: readonly T[], limit: number): readonly T[] {
  return rows.length <= limit ? rows : rows.slice(-limit);
}
export function encodeThreadHistoryCursor(threadId: string, messageId: string): string {
  return encodeBase64Url(JSON.stringify({ version: 1, threadId, messageId }));
}
export function historyCursorAfterTrim<
  P extends {
    beforeCursor: string | null;
    hasMore: boolean;
    windowStart?: OrchestrationMessageOrigin | null | undefined;
    userOrigins?: Readonly<Record<string, OrchestrationMessageOrigin>> | undefined;
  },
>(page: P, threadId: string, messages: readonly { id: string; role: string }[]): P {
  const first = messages.find((message) => message.role === "user");
  if (!first) return page;
  const userOrigins = Object.fromEntries(
    messages
      .filter((message) => message.role === "user" && page.userOrigins?.[message.id] !== undefined)
      .map((message) => [message.id, page.userOrigins![message.id]!]),
  );
  return {
    ...page,
    beforeCursor: encodeThreadHistoryCursor(threadId, first.id),
    hasMore: true,
    windowStart: userOrigins[first.id] ?? null,
    userOrigins,
  };
}
export function isHistoryCursorExpired(error: unknown): boolean {
  const seen = new Set<object>();
  while (typeof error === "object" && error !== null && !seen.has(error)) {
    seen.add(error);
    if ("reason" in error && error.reason === "history-cursor-stale") return true;
    if (
      "message" in error &&
      typeof error.message === "string" &&
      error.message.includes("History changed; reload this thread")
    )
      return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}

interface HistoryRequest {
  id: number;
  epoch: number;
  sequence: number;
  kind: "older" | "around";
  snapshot: OrchestrationThreadDetailSnapshot | null;
}
export interface HistoryPagerState {
  epoch: number;
  sequence: number;
  nextRequestId: number;
  hasSnapshot: boolean;
  needsSnapshot: boolean;
  loadedTurns: number;
  requestedTurns: number;
  page: OrchestrationThreadDetailPage | null;
  pending: HistoryRequest | null;
  bufferedMessages: readonly OrchestrationEvent[];
  error: string | null;
}
export type HistoryPagerInput =
  | { type: "snapshot"; snapshot: OrchestrationThreadDetailSnapshot }
  | { type: "request"; kind: "older" | "around" }
  | { type: "page"; requestId: number; snapshot: OrchestrationThreadDetailSnapshot }
  | {
      type: "event";
      event: OrchestrationEvent;
      messageOrigin?: OrchestrationMessageOrigin;
      loadedMessageIds: readonly string[];
    }
  | { type: "synchronized"; sequence?: number }
  | { type: "invalidate"; reload: boolean }
  | { type: "failure"; requestId: number; message: string; expired?: boolean }
  | { type: "retained"; page: OrchestrationThreadDetailPage; loadedTurns: number };
export type HistoryPagerEffect =
  | { type: "replace-snapshot"; snapshot: OrchestrationThreadDetailSnapshot }
  | { type: "apply-event"; event: OrchestrationEvent }
  | {
      type: "merge-page";
      snapshot: OrchestrationThreadDetailSnapshot;
      events: readonly OrchestrationEvent[];
      advanceCursor: boolean;
    }
  | { type: "reload" };
const countTurns = (snapshot: OrchestrationThreadDetailSnapshot) =>
  snapshot.thread.messages.filter((message) => message.role === "user").length;
export function createHistoryPager(
  snapshot?: OrchestrationThreadDetailSnapshot,
): HistoryPagerState {
  const loadedTurns = snapshot === undefined ? 0 : countTurns(snapshot);
  return {
    epoch: 0,
    sequence: snapshot?.snapshotSequence ?? 0,
    nextRequestId: 0,
    hasSnapshot: snapshot !== undefined,
    needsSnapshot: false,
    loadedTurns,
    requestedTurns: loadedTurns,
    page: snapshot?.page ?? null,
    pending: null,
    bufferedMessages: [],
    error: null,
  };
}
function outsideWindow(
  state: HistoryPagerState,
  input: Extract<HistoryPagerInput, { type: "event" }>,
): boolean {
  const start = state.page?.windowStart,
    origin = input.messageOrigin,
    event = input.event;
  if (
    !start ||
    !origin ||
    event.type !== "thread.message-sent" ||
    input.loadedMessageIds.includes(event.payload.messageId)
  )
    return false;
  if (start.sequence === null) return origin.sequence === null && origin.rowId < start.rowId;
  return (
    origin.sequence === null ||
    origin.sequence < start.sequence ||
    (origin.sequence === start.sequence && origin.rowId < start.rowId)
  );
}
function readyPage(state: HistoryPagerState): {
  state: HistoryPagerState;
  effects: HistoryPagerEffect[];
} {
  const pending = state.pending,
    snapshot = pending?.snapshot;
  if (
    !pending ||
    !snapshot ||
    (snapshot.page?.threadSequence !== undefined && snapshot.page.threadSequence > state.sequence)
  )
    return { state, effects: [] };
  const ids = new Set(snapshot.thread.messages.map((message) => message.id));
  const events = state.bufferedMessages.filter(
    (event) =>
      event.sequence > (snapshot.page?.threadSequence ?? snapshot.snapshotSequence) &&
      event.type === "thread.message-sent" &&
      ids.has(event.payload.messageId),
  );
  const loadedTurns = state.loadedTurns + (pending.kind === "older" ? countTurns(snapshot) : 0);
  return {
    state: {
      ...state,
      pending: null,
      bufferedMessages: [],
      page: pending.kind === "older" ? (snapshot.page ?? null) : state.page,
      loadedTurns,
      requestedTurns: Math.max(state.requestedTurns, loadedTurns),
      error: null,
    },
    effects: [{ type: "merge-page", snapshot, events, advanceCursor: pending.kind === "older" }],
  };
}
/** Pure transitions own fencing, message membership, watermarks and reload depth.
 * Adapters only perform I/O and apply the returned effects. */
export function reduceHistoryPager(
  state: HistoryPagerState,
  input: HistoryPagerInput,
): { state: HistoryPagerState; effects: HistoryPagerEffect[] } {
  switch (input.type) {
    case "snapshot": {
      const loadedTurns = countTurns(input.snapshot);
      return {
        state: {
          ...state,
          epoch: state.epoch + 1,
          sequence: input.snapshot.snapshotSequence,
          hasSnapshot: true,
          needsSnapshot: false,
          page: input.snapshot.page ?? null,
          loadedTurns,
          requestedTurns: Math.max(state.requestedTurns, state.loadedTurns, loadedTurns),
          pending: null,
          bufferedMessages: [],
          error: null,
        },
        effects: [{ type: "replace-snapshot", snapshot: input.snapshot }],
      };
    }
    case "request":
      if (state.needsSnapshot)
        return { state: { ...state, error: "History is refreshing" }, effects: [] };
      if (state.pending) return { state, effects: [] };
      if (input.kind === "older" && (!state.page?.hasMore || !state.page.beforeCursor))
        return {
          state: { ...state, error: state.page?.hasMore ? "History is unavailable" : null },
          effects: [],
        };
      return {
        state: {
          ...state,
          nextRequestId: state.nextRequestId + 1,
          error: null,
          bufferedMessages: [],
          pending: {
            id: state.nextRequestId + 1,
            epoch: state.epoch,
            sequence: state.sequence,
            kind: input.kind,
            snapshot: null,
          },
        },
        effects: [],
      };
    case "page":
      if (state.pending?.id !== input.requestId || state.pending.epoch !== state.epoch)
        return { state, effects: [] };
      if (input.snapshot.snapshotSequence < state.pending.sequence)
        return reduceHistoryPager(state, {
          type: "failure",
          requestId: input.requestId,
          message: "History changed while loading. Please retry.",
        });
      return readyPage({ ...state, pending: { ...state.pending, snapshot: input.snapshot } });
    case "synchronized":
      return readyPage({
        ...state,
        sequence: Math.max(state.sequence, input.sequence ?? state.sequence),
      });
    case "event": {
      if (input.event.sequence <= state.sequence) return { state, effects: [] };
      const sequence = input.event.sequence;
      if (input.event.type === "thread.reverted" && state.page) {
        const invalid = reduceHistoryPager(
          { ...state, sequence },
          { type: "invalidate", reload: true },
        );
        return {
          state: invalid.state,
          effects: [{ type: "apply-event", event: input.event }, ...invalid.effects],
        };
      }
      let next = { ...state, sequence };
      if (
        state.page &&
        input.event.type === "thread.message-sent" &&
        input.event.payload.role === "user" &&
        input.messageOrigin
      )
        next = {
          ...next,
          page: {
            ...state.page,
            userOrigins: {
              ...state.page.userOrigins,
              [input.event.payload.messageId]: input.messageOrigin,
            },
          },
        };
      const outside = outsideWindow(state, input);
      if (outside && state.pending)
        next = { ...next, bufferedMessages: [...state.bufferedMessages, input.event] };
      // Bound a pathological in-flight historical stream; a snapshot recovers
      // the baseline instead of retaining unlimited delta objects.
      if (next.bufferedMessages.length > 4096)
        return reduceHistoryPager(next, { type: "invalidate", reload: true });
      const ready = readyPage(next);
      const effects: HistoryPagerEffect[] = outside
        ? ready.effects
        : [{ type: "apply-event", event: input.event }, ...ready.effects];
      return { state: ready.state, effects };
    }
    case "invalidate":
      return {
        state: {
          ...state,
          epoch: state.epoch + 1,
          pending: null,
          bufferedMessages: [],
          error: null,
          needsSnapshot: input.reload || state.needsSnapshot,
          requestedTurns: Math.max(state.requestedTurns, state.loadedTurns),
        },
        effects: input.reload ? [{ type: "reload" }] : [],
      };
    case "failure":
      if (state.pending?.id !== input.requestId) return { state, effects: [] };
      if (input.expired) return reduceHistoryPager(state, { type: "invalidate", reload: true });
      return {
        state: { ...state, pending: null, bufferedMessages: [], error: input.message },
        effects: [],
      };
    case "retained":
      return {
        state: {
          ...state,
          page: input.page,
          loadedTurns: input.loadedTurns,
          ...(state.pending && input.page.beforeCursor !== state.page?.beforeCursor
            ? { epoch: state.epoch + 1, pending: null, bufferedMessages: [] }
            : {}),
          requestedTurns:
            state.needsSnapshot || state.requestedTurns > state.loadedTurns
              ? state.requestedTurns
              : input.loadedTurns,
        },
        effects: [],
      };
  }
}
