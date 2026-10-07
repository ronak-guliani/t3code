import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationThread,
  type OrchestrationEvent,
  type OrchestrationThreadDetailPage,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";
import {
  INITIAL_THREAD_USER_TURN_LIMIT,
  OLDER_THREAD_PAGE_USER_TURN_LIMIT,
  mergeHistoryCollections,
} from "@t3tools/shared/threadHistory";
import {
  createHistoryPager,
  reduceHistoryPager,
  historyRetentionLimits,
  retainHistoryRows,
  isHistoryCursorExpired,
  DEFAULT_HISTORY_RETENTION,
  THREAD_HISTORY_PAGE_WAIT_TIMEOUT_MS,
  type HistoryPagerInput,
  type HistoryPagerState,
} from "@t3tools/shared/threadHistoryState";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { ThreadSnapshotLoader, type ThreadSnapshotWindow } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_SNAPSHOT_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadPageState,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function pageStateFromSnapshot(
  page: OrchestrationThreadDetailPage | undefined,
  thread?: OrchestrationThread,
): Option.Option<EnvironmentThreadPageState> {
  return page === undefined
    ? Option.none()
    : Option.some({
        beforeCursor: page.beforeCursor,
        hasMore: page.hasMore,
        loadingOlder: false,
        metadata: page,
        ...(thread === undefined ? {} : { retention: historyRetentionLimits(thread) }),
      });
}

interface ThreadOlderTurnRequestRegistry {
  /**
   * Registers the live state machine for a thread. Returns the deregistration
   * cleanup; registration lives exactly as long as the machine's scope, and a
   * successor machine for the same thread simply replaces the entry.
   */
  readonly register: (key: string, handler: () => void) => () => void;
  readonly request: (key: string) => boolean;
}

function makeThreadOlderTurnRequestRegistry(): ThreadOlderTurnRequestRegistry {
  const handlers = new Map<string, () => void>();
  return {
    register: (key, handler) => {
      handlers.set(key, handler);
      return () => {
        if (handlers.get(key) === handler) {
          handlers.delete(key);
        }
      };
    },
    request: (key) => {
      const handler = handlers.get(key);
      if (handler === undefined) {
        return false;
      }
      handler();
      return true;
    },
  };
}

const defaultOlderTurnRequestRegistry = makeThreadOlderTurnRequestRegistry();

/**
 * Channel from UI actions to the live per-thread state machines. The machines
 * resolve it from the Effect environment (overridable in tests); the default
 * instance is shared with the sync `requestOlderThreadTurns` entry point so
 * the apps get working wiring without providing anything.
 */
export class ThreadOlderTurnRequests extends Context.Reference<ThreadOlderTurnRequestRegistry>(
  "@t3tools/client-runtime/state/threads/ThreadOlderTurnRequests",
  { defaultValue: () => defaultOlderTurnRequestRegistry },
) {}

/**
 * Asks the live state machine for `threadId` to fetch the next older page.
 * Returns false when no machine is live or no fetch was started (no cursor,
 * already loading); callers render from `EnvironmentThreadState.page` and can
 * treat false as "nothing to do".
 */
export function requestOlderThreadTurns(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
): boolean {
  return defaultOlderTurnRequestRegistry.request(threadKey({ environmentId, threadId }));
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function shouldPersistThread(thread: OrchestrationThread): boolean {
  const status = thread.session?.status;
  return status !== "starting" && status !== "running";
}

interface ThreadResumeSnapshot {
  readonly state: EnvironmentThreadState;
  readonly sequence: number;
  readonly persisted: boolean;
  readonly history: Pick<HistoryPagerState, "needsSnapshot" | "requestedTurns">;
}

interface ThreadResumeCache {
  snapshot: ThreadResumeSnapshot | undefined;
  owner: object | undefined;
}

function matchesThreadSnapshot(
  current: ThreadResumeSnapshot,
  thread: OrchestrationThread | null,
  sequence: number,
  page: Pick<EnvironmentThreadPageState, "beforeCursor" | "hasMore"> | undefined,
): boolean {
  if (current.sequence !== sequence || Option.getOrNull(current.state.data) !== thread)
    return false;
  const currentPage = Option.getOrUndefined(current.state.page);
  return currentPage === undefined
    ? page === undefined
    : page !== undefined &&
        currentPage.beforeCursor === page.beforeCursor &&
        currentPage.hasMore === page.hasMore;
}

function cachedThreadState(value: EnvironmentThreadState): EnvironmentThreadState {
  return {
    ...value,
    status: value.status === "deleted" ? "deleted" : statusWithoutLiveData(value.data),
    error: Option.none(),
    page: Option.map(value.page, (page) => ({ ...page, loadingOlder: false })),
  };
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
  resumeCache?: ThreadResumeCache,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const scope = yield* Effect.scope;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = Option.getOrUndefined(yield* Effect.serviceOption(ThreadSnapshotLoader));
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const retained = resumeCache?.snapshot;
  const owner = {};
  if (resumeCache) resumeCache.owner = owner;
  const cached =
    retained === undefined
      ? yield* cache.loadThread(environmentId, threadId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not load cached thread.").pipe(
              Effect.annotateLogs({
                environmentId,
                threadId,
                error: error.message,
              }),
              Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
            ),
          ),
        )
      : Option.none<OrchestrationThreadDetailSnapshot>();
  const cachedThread = Option.map(cached, (snapshot) => snapshot.thread);
  const initialState: EnvironmentThreadState = retained
    ? cachedThreadState(retained.state)
    : {
        data: cachedThread,
        status: statusWithoutLiveData(cachedThread),
        error: Option.none(),
        // A cached windowed snapshot restores its page cursor so "load earlier"
        // works while rendering from cache; a cached full snapshot has no page.
        page: Option.flatMap(cached, (snapshot) =>
          pageStateFromSnapshot(snapshot.page, snapshot.thread),
        ),
      };
  const state = yield* SubscriptionRef.make(initialState);
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const initialSequence =
    retained?.sequence ??
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence });
  const lastSequence = yield* SubscriptionRef.make(initialSequence);
  const awaitingCompletion = yield* Ref.make(false);
  // Bumped whenever loaded history may have been rewritten out from under an
  // in-flight older-page fetch (snapshot replacement, revert, deletion). A
  // page response captured under an older epoch is discarded, not merged.
  const initialPage = Option.getOrUndefined(initialState.page);
  const initialHistory = createHistoryPager(
    Option.isNone(initialState.data)
      ? undefined
      : {
          snapshotSequence: initialSequence,
          thread: initialState.data.value,
          ...(initialPage === undefined
            ? {}
            : {
                page: initialPage.metadata ?? {
                  beforeCursor: initialPage.beforeCursor,
                  hasMore: initialPage.hasMore,
                  snapshotSequence: initialSequence,
                },
              }),
        },
  );
  if (retained) {
    initialHistory.needsSnapshot = retained.history.needsSnapshot;
    initialHistory.requestedTurns = retained.history.requestedTurns;
  }
  const pager = yield* Ref.make(initialHistory);
  let committed: ThreadResumeSnapshot = {
    state: initialState,
    sequence: initialSequence,
    persisted: retained?.persisted ?? Option.isSome(cached),
    history: {
      needsSnapshot: initialHistory.needsSnapshot,
      requestedTurns: initialHistory.requestedTurns,
    },
  };
  if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
  const historyReloads = yield* Queue.unbounded<void>();
  const pageTimeouts = yield* Queue.unbounded<number>();
  const pageTimeout = yield* Ref.make<{ id: number; fiber: Fiber.Fiber<void> } | null>(null);
  const olderTurnRequests = yield* Queue.sliding<void>(1);
  // Serializes stream-item application against older-page staleness checks +
  // merges. Without it, a revert or snapshot processed between loadOlderTurns'
  // epoch check and its merge could still slip resurrected history in.
  const applyLock = yield* Semaphore.make(1);
  // Save only completed data/cursor updates. A canceled scope must not cache
  // a cursor whose event has not reached the data yet.
  const remember = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const sequence = yield* SubscriptionRef.get(lastSequence);
    const { needsSnapshot, requestedTurns } = yield* Ref.get(pager);
    committed = {
      state: current,
      sequence,
      history: { needsSnapshot, requestedTurns },
      persisted:
        !needsSnapshot &&
        committed.persisted &&
        matchesThreadSnapshot(
          committed,
          Option.getOrNull(current.data),
          sequence,
          Option.getOrUndefined(current.page),
        ),
    };
    if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
  });
  // Whether the connected server accepts windowed reads; set per subscription
  // from the session config. Gates loadOlderTurns so a reconnect to a
  // pre-pagination server never sends unsupported window parameters.
  const paginationSupported = yield* Ref.make(false);
  // An older page whose thread watermark is ahead of the live state, parked
  // until the subscription catches up (see mergeOlderPage's caller). At most
  // one can exist because loadOlderTurns no-ops while loadingOlder is true.
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    if (resumeCache !== undefined && resumeCache.owner !== owner) return;
    // Recovery-required rows may render, but are not an authoritative cache baseline.
    if (committed.history.needsSnapshot) return;
    if (
      committed.persisted &&
      matchesThreadSnapshot(committed, snapshot.thread, snapshot.snapshotSequence, snapshot.page)
    )
      return;
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (
            !matchesThreadSnapshot(
              committed,
              snapshot.thread,
              snapshot.snapshotSequence,
              snapshot.page,
            )
          )
            return;
          committed = { ...committed, persisted: true };
          if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setSynchronizing = SubscriptionRef.update(state, (current) =>
    current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    // The capability belongs to the session that advertised it. During a
    // reconnect, a new prepared connection can exist before the new session's
    // config arrives; leaving the old value would let loadOlderTurns send
    // window parameters to a server that may not accept them (review
    // finding). makeSubscribeInput re-sets it from the next session's config.
    yield* Ref.set(paginationSupported, false);
    yield* applyLock.withPermits(1)(transitionHistory({ type: "invalidate", reload: false }));
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(
        applyLock.withPermits(1)(transitionHistory({ type: "invalidate", reload: false })),
      ),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(formatThreadError(cause)),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationThread,
    // "keep" preserves the current page state (live events touch only loaded
    // recent turns); a snapshot or merged page passes its own page state.
    page: Option.Option<EnvironmentThreadPageState> | "keep",
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    const current = yield* SubscriptionRef.get(state);
    const nextPage = page === "keep" ? current.page : page;
    let removedCount = 0;
    if (Option.isSome(nextPage)) {
      const limits = nextPage.value.retention ?? DEFAULT_HISTORY_RETENTION;
      const messages = retainHistoryRows(thread.messages, limits.messages);
      removedCount = thread.messages.length - messages.length;
      const activities = retainHistoryRows(thread.activities, limits.activities);
      const evicted = thread.activities.slice(
        0,
        Math.max(0, thread.activities.length - activities.length),
      );
      thread = {
        ...thread,
        messages,
        activities,
        checkpoints: retainHistoryRows(thread.checkpoints, limits.checkpoints),
        proposedPlans: retainHistoryRows(thread.proposedPlans, limits.proposedPlans),
        hasMoreActivities: thread.hasMoreActivities === true || evicted.length > 0,
        hasMoreCurrentTurnActivities:
          thread.hasMoreCurrentTurnActivities === true ||
          (thread.latestTurn !== null &&
            evicted.some((activity) => activity.turnId === thread.latestTurn?.turnId)),
      };
    }
    yield* SubscriptionRef.set(state, {
      data: Option.some(thread),
      status: waiting ? ("synchronizing" as const) : ("live" as const),
      error: Option.none(),
      page: nextPage,
    });
    return removedCount;
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* Ref.update(
      pager,
      (value) => reduceHistoryPager(value, { type: "invalidate", reload: false }).state,
    );
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
      page: Option.none(),
    });
    yield* remember;
    if (resumeCache !== undefined && resumeCache.owner !== owner) return;
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  // Transport adapters share the pure history transitions with the web client.
  const transitionHistory = Effect.fn("EnvironmentThreadState.transitionHistory")(function* (
    input: HistoryPagerInput,
  ) {
    const previous = yield* Ref.get(pager);
    const result = reduceHistoryPager(previous, input);
    yield* Ref.set(pager, result.state);
    yield* SubscriptionRef.set(lastSequence, result.state.sequence);
    let removedCount = 0;
    for (const effect of result.effects) {
      switch (effect.type) {
        case "replace-snapshot":
          removedCount += yield* setThread(
            effect.snapshot.thread,
            pageStateFromSnapshot(effect.snapshot.page, effect.snapshot.thread),
          );
          break;
        case "merge-page":
          yield* mergeOlderPage(effect.snapshot, effect.events);
          break;
        case "reload":
          yield* Queue.offer(historyReloads, undefined);
          break;
        case "apply-event": {
          const current = yield* SubscriptionRef.get(state);
          if (Option.isNone(current.data)) {
            if (effect.event.type === "thread.deleted") yield* setDeleted();
            break;
          }
          const update = applyThreadDetailEvent(current.data.value, effect.event);
          if (update.kind === "updated") removedCount += yield* setThread(update.thread, "keep");
          if (update.kind === "deleted") yield* setDeleted();
          break;
        }
      }
    }
    const current = yield* SubscriptionRef.get(state);
    const changedDepth =
      input.type === "snapshot" ||
      result.effects.some((effect) => effect.type === "merge-page") ||
      (input.type === "event" &&
        (input.event.type === "thread.reverted" ||
          (input.event.type === "thread.message-sent" && input.event.payload.role === "user")));
    if (Option.isSome(current.data) && (changedDepth || removedCount > 0)) {
      const retained = reduceHistoryPager(yield* Ref.get(pager), {
        type: "retained",
        thread: current.data.value,
        removedCount,
      });
      yield* Ref.set(pager, retained.state);
      for (const effect of retained.effects)
        if (effect.type === "reload") yield* Queue.offer(historyReloads, undefined);
    }
    const final = yield* Ref.get(pager);
    yield* SubscriptionRef.update(state, (value) => {
      const page = Option.getOrNull(value.page);
      const error =
        final.error === null
          ? input.type === "request"
            ? Option.none<string>()
            : value.error
          : Option.some(final.error);
      if (
        !page ||
        !final.page ||
        (page.loadingOlder === (final.pending !== null) &&
          page.metadata === final.page &&
          Option.getOrNull(error) === Option.getOrNull(value.error))
      )
        return value;
      return {
        ...value,
        error,
        page: Option.some({
          ...page,
          metadata: final.page,
          beforeCursor: final.page.beforeCursor,
          hasMore: final.page.hasMore,
          loadingOlder: final.pending !== null,
        }),
      };
    });
    const deadline = yield* Ref.get(pageTimeout);
    if (deadline && deadline.id !== final.pending?.id) {
      yield* Ref.set(pageTimeout, null);
      yield* Fiber.interrupt(deadline.fiber);
    }
    if (input.type === "page" && final.pending?.snapshot) {
      const id = final.pending.id;
      const fiber = yield* Effect.sleep(THREAD_HISTORY_PAGE_WAIT_TIMEOUT_MS).pipe(
        Effect.andThen(Queue.offer(pageTimeouts, id)),
        Effect.asVoid,
        Effect.forkIn(scope),
      );
      yield* Ref.set(pageTimeout, { id, fiber });
    }
    // Persist data with the canonical boundary *after* projection, never a
    // trimmed/merged window paired with the previous cursor. Active streaming
    // stays off the cache encoding path; merged data uses the loaded watermark.
    const value = yield* SubscriptionRef.get(state);
    if (
      result.effects.length > 0 &&
      !final.needsSnapshot &&
      Option.isSome(value.data) &&
      shouldPersistThread(value.data.value)
    )
      yield* Queue.offer(persistence, {
        snapshotSequence: final.sequence,
        thread: value.data.value,
        ...(final.page ? { page: { ...final.page, snapshotSequence: final.sequence } } : {}),
      });
    if (
      (input.type === "snapshot" ||
        result.effects.some((effect) => effect.type === "merge-page")) &&
      final.page?.hasMore &&
      final.loadedTurns < final.requestedTurns
    )
      yield* Queue.offer(olderTurnRequests, undefined);
    yield* remember;
  });

  const applyItemLocked = Effect.fn("EnvironmentThreadState.applyItemLocked")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    if (item.kind === "synchronized") {
      yield* Ref.set(awaitingCompletion, false);
      yield* transitionHistory({
        type: "synchronized",
        ...(item.sequence === undefined ? {} : { sequence: item.sequence }),
      });
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted"
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      yield* transitionHistory({ type: "snapshot", snapshot: item.snapshot });
      return;
    }

    const current = yield* SubscriptionRef.get(state);
    yield* transitionHistory({
      type: "event",
      event: item.event,
      ...(item.messageOrigin === undefined ? {} : { messageOrigin: item.messageOrigin }),
      loadedMessageIds:
        item.event.type === "thread.message-sent" && Option.isSome(current.data)
          ? current.data.value.messages.map((message) => message.id)
          : [],
    });
  });

  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    yield* applyLock.withPermits(1)(applyItemLocked(item).pipe(Effect.andThen(remember)));
  });

  // Merges an older disjoint page below the currently loaded window. All four
  // windowed collections prepend; identity dedupe guards the (server-bug or
  // cursor-misuse) case of overlapping pages so a row never renders twice.
  const mergeOlderPage = Effect.fn("EnvironmentThreadState.mergeOlderPage")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
    buffered: readonly OrchestrationEvent[],
  ) {
    // The merge is built inside the update callback so it composes with
    // whatever thread value is current at commit time. The applyLock already
    // serializes this against event application; the atomic build is defense
    // in depth against future callers outside the lock.
    let merged: OrchestrationThread | null = null;
    yield* SubscriptionRef.update(state, (value) => {
      if (Option.isNone(value.data)) {
        return value;
      }
      const loaded = value.data.value;
      const older = snapshot.thread;
      merged = {
        // Thread metadata stays the loaded (newer) snapshot's; only the
        // windowed collections gain rows from the older page.
        ...loaded,
        hasMoreActivities: loaded.hasMoreActivities === true || older.hasMoreActivities === true,
        hasMoreCurrentTurnActivities:
          loaded.hasMoreCurrentTurnActivities === true ||
          (loaded.latestTurn?.turnId === older.latestTurn?.turnId &&
            older.hasMoreCurrentTurnActivities === true),
        ...mergeHistoryCollections(older, loaded),
      };
      for (const event of buffered) {
        const update = applyThreadDetailEvent(merged, event);
        if (update.kind === "updated") merged = update.thread;
      }
      return {
        ...value,
        data: Option.some(merged),
        page: Option.map(value.page, (page) => ({
          ...page,
          retention: historyRetentionLimits(merged!),
        })),
      };
    });
  });

  const loadOlderTurns = Effect.fn("EnvironmentThreadState.loadOlderTurns")(function* () {
    if (snapshotLoader === undefined) return;
    // Gated on the connected server's capability: a reconnect to a
    // pre-pagination server must never receive window parameters.
    if (!(yield* Ref.get(paginationSupported))) {
      return;
    }
    const current = yield* Ref.get(pager);
    const page = current.page;
    if (page === null || current.pending !== null || !page.hasMore || page.beforeCursor === null) {
      return;
    }
    const prepared = Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared));
    if (prepared === null) {
      return;
    }
    yield* applyLock.withPermits(1)(transitionHistory({ type: "request", kind: "older" }));
    const requestId = (yield* Ref.get(pager)).pending?.id;
    if (requestId === undefined) return;
    const requested = yield* Ref.get(pager);
    const window: ThreadSnapshotWindow = {
      turnLimit:
        requested.requestedTurns > requested.loadedTurns
          ? Math.min(
              OLDER_THREAD_PAGE_USER_TURN_LIMIT,
              requested.requestedTurns - requested.loadedTurns,
            )
          : OLDER_THREAD_PAGE_USER_TURN_LIMIT,
      beforeCursor: page.beforeCursor,
    };
    const response = yield* snapshotLoader.load(prepared, threadId, window).pipe(
      Effect.result,
      Effect.onInterrupt(() =>
        applyLock.withPermits(1)(transitionHistory({ type: "invalidate", reload: false })),
      ),
    );
    yield* applyLock.withPermits(1)(
      response._tag === "Failure"
        ? transitionHistory({
            type: "failure",
            requestId,
            message: response.failure.message,
            expired: isHistoryCursorExpired(response.failure),
          })
        : Option.isNone(response.success)
          ? transitionHistory({
              type: "failure",
              requestId,
              message: "Earlier history is unavailable",
            })
          : transitionHistory({ type: "page", requestId, snapshot: response.success.value }),
    );
  });

  yield* Stream.fromQueue(pageTimeouts).pipe(
    Stream.runForEach((requestId) =>
      applyLock.withPermits(1)(
        transitionHistory({
          type: "failure",
          requestId,
          message: "Earlier history timed out. Please retry.",
        }),
      ),
    ),
    Effect.forkScoped,
  );

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        const config = yield* session.initialConfig.pipe(
          Effect.orElseSucceed(
            () =>
              ({}) as {
                threadResumeCompletionMarker?: boolean;
                threadSnapshotPagination?: boolean;
              },
          ),
        );
        const supportsCompletionMarker = config.threadResumeCompletionMarker === true;
        // Windowed loads are gated on the server capability: pre-pagination
        // servers reject unknown query params, and a windowed WS fallback to
        // such a server would silently hide history.
        const supportsPagination =
          snapshotLoader !== undefined && config.threadSnapshotPagination === true;
        yield* Ref.set(paginationSupported, supportsPagination);
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        let current = yield* SubscriptionRef.get(state);
        let reloadSnapshot = (yield* Ref.get(pager)).needsSnapshot;
        // A windowed cache resuming against a server without pagination is a
        // trap: afterSequence resume keeps only the window, and the missing
        // older turns can never be loaded (the server has no cursor reads).
        // Drop the window marker and treat the data as needing a full reload.
        if (!supportsPagination) {
          yield* applyLock.withPermits(1)(
            Effect.gen(function* () {
              if (Option.isNone((yield* SubscriptionRef.get(state)).page)) return;
              yield* Ref.set(pager, createHistoryPager());
              reloadSnapshot = true;
              yield* SubscriptionRef.update(state, (value) => ({
                ...value,
                data: Option.none(),
                status: value.status === "deleted" ? value.status : ("empty" as const),
                page: Option.none(),
              }));
              yield* SubscriptionRef.set(lastSequence, 0);
              yield* remember;
            }),
          );
          current = yield* SubscriptionRef.get(state);
        }
        if (
          snapshotLoader !== undefined &&
          (Option.isNone(current.data) || reloadSnapshot) &&
          current.status !== "deleted"
        ) {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          const httpSnapshot = yield* snapshotLoader
            .load(
              prepared,
              threadId,
              supportsPagination
                ? {
                    turnLimit: Math.min(
                      100,
                      Math.max(
                        INITIAL_THREAD_USER_TURN_LIMIT,
                        (yield* Ref.get(pager)).requestedTurns,
                      ),
                    ),
                  }
                : undefined,
            )
            .pipe(
              Effect.catch(() => Effect.succeed(Option.none<OrchestrationThreadDetailSnapshot>())),
            );
          if (Option.isSome(httpSnapshot)) {
            yield* applyItem({ kind: "snapshot", snapshot: httpSnapshot.value });
            current = yield* SubscriptionRef.get(state);
            reloadSnapshot = false;
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data) && !reloadSnapshot;
        if (!supportsCompletionMarker && canResume) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
          // The WS fallback snapshot (sent when afterSequence is missing or
          // the gap is too large) should be windowed the same as the HTTP
          // path; without this a resume failure re-downloads the full thread.
          ...(supportsPagination
            ? {
                turnLimit: Math.min(
                  100,
                  Math.max(INITIAL_THREAD_USER_TURN_LIMIT, (yield* Ref.get(pager)).requestedTurns),
                ),
              }
            : {}),
        };
      }),
      {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: "250 millis",
        resubscribe: Stream.merge(foregroundResubscriptions, Stream.fromQueue(historyReloads)),
      },
    ).pipe(Stream.runForEach(applyItem)),
  );

  // Expose loadOlderTurns to UI actions through the request registry.
  // Requests funnel through a sliding queue drained serially, so mashing
  // "load earlier" coalesces (loadOlderTurns itself no-ops while a fetch is
  // in flight).
  const olderTurnRequestRegistry = yield* ThreadOlderTurnRequests;
  yield* Stream.fromQueue(olderTurnRequests).pipe(
    Stream.runForEach(() => loadOlderTurns()),
    Effect.forkScoped,
  );
  const deregister = olderTurnRequestRegistry.register(
    threadKey({ environmentId, threadId }),
    () => {
      Queue.offerUnsafe(olderTurnRequests, undefined);
    },
  );
  yield* Effect.addFinalizer(() => Effect.sync(deregister));

  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const { state: current, sequence: snapshotSequence } = committed;
      return Option.match(current.data, {
        onNone: () => Effect.void,
        onSome: (thread) =>
          shouldPersistThread(thread)
            ? persist({
                snapshotSequence,
                thread,
                ...Option.match(current.page, {
                  onNone: () => ({}),
                  onSome: (page) =>
                    ({
                      page: {
                        ...page.metadata,
                        beforeCursor: page.beforeCursor,
                        hasMore: page.hasMore,
                        snapshotSequence,
                      },
                    }) as const,
                }),
              })
            : Effect.void,
      });
    }),
  );

  return state;
});

export function threadStateChanges(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
  resumeCache?: ThreadResumeCache,
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentThreadState(threadId, resumeCache).pipe(Effect.map(SubscriptionRef.changes)),
    ),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  // Cache definitions must outlive collectible live-atom definitions. The
  // registry retains these nodes without retaining environment or RPC scopes.
  const resumeFamily = Atom.family((key: string) =>
    Atom.make(
      (): ThreadResumeCache => ({
        snapshot: undefined,
        owner: undefined,
      }),
    ).pipe(
      Atom.setIdleTTL(THREAD_SNAPSHOT_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-resume:${key}`),
    ),
  );
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    const resumeAtom = resumeFamily(key);
    return runtime
      .atom(
        (get) => {
          get.mount(resumeAtom);
          const resume = get.once(resumeAtom);
          const live = threadStateChanges(environmentId, threadId, resume);
          return resume.snapshot === undefined
            ? live
            : Stream.concat(Stream.succeed(cachedThreadState(resume.snapshot.state)), live);
        },
        {
          initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
        },
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-state:${key}`));
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadFeedback.ts";
export { parsePiSessionCommand } from "./piSessionCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
