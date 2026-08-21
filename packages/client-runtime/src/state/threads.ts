import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribe, type EnvironmentRpcStreamFailure } from "../rpc/client.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

const THREAD_STREAM_QUEUE_CAPACITY = 1024;

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationThread>()),
      ),
    ),
  );
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cached,
    status: statusWithoutLiveData(cached),
    error: Option.none(),
  });
  const lastSequence = yield* SubscriptionRef.make(0);
  const persistence = yield* Queue.sliding<OrchestrationThread>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    thread: OrchestrationThread,
  ) {
    yield* cache.saveThread(environmentId, thread).pipe(
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

  const setSynchronizing = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: "synchronizing" as const,
    error: Option.none(),
  }));
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
  }));
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
      error: Option.some(formatThreadError(cause)),
    }));

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationThread,
  ) {
    yield* SubscriptionRef.set(state, {
      data: Option.some(thread),
      status: "live",
      error: Option.none(),
    });
    yield* Queue.offer(persistence, thread);
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
    });
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

  const applyEventBatch = Effect.fn("EnvironmentThreadState.applyEventBatch")(function* (
    events: ReadonlyArray<Extract<OrchestrationThreadStreamItem, { kind: "event" }>>,
  ) {
    if (events.length === 0) {
      return;
    }

    const lastAppliedSequence = yield* SubscriptionRef.get(lastSequence);
    const applicable = events.filter((item) => item.event.sequence > lastAppliedSequence);
    if (applicable.length === 0) {
      return;
    }

    // Fold all events through the reducer against evolving local state so one
    // batch produces at most one state write and one persistence offer.
    let data = (yield* SubscriptionRef.get(state)).data;
    let deleted = false;
    for (const item of applicable) {
      if (Option.isNone(data)) {
        if (item.event.type === "thread.deleted") {
          deleted = true;
        }
        continue;
      }
      const result = applyThreadDetailEvent(data.value, item.event);
      if (result.kind === "updated") {
        data = Option.some(result.thread);
      } else if (result.kind === "deleted") {
        data = Option.none();
        deleted = true;
      }
    }

    yield* SubscriptionRef.set(
      lastSequence,
      Math.max(...applicable.map((item) => item.event.sequence)),
    );
    if (deleted && Option.isNone(data)) {
      yield* setDeleted();
      return;
    }
    if (Option.isSome(data)) {
      yield* setThread(data.value);
    }
  });

  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: Exclude<OrchestrationThreadStreamItem, { kind: "event" }>,
  ) {
    if (item.kind === "snapshot") {
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence);
      yield* setThread(item.snapshot.thread);
      return;
    }
    if (item.sequence !== undefined) {
      yield* SubscriptionRef.update(lastSequence, (sequence) =>
        Math.max(sequence, item.sequence ?? sequence),
      );
    }
  });

  const applyItems = Effect.fn("EnvironmentThreadState.applyItems")(function* (
    items: ReadonlyArray<OrchestrationThreadStreamItem>,
  ) {
    let events: Array<Extract<OrchestrationThreadStreamItem, { kind: "event" }>> = [];
    for (const item of items) {
      if (item.kind === "event") {
        events.push(item);
        continue;
      }
      yield* applyEventBatch(events);
      events = [];
      yield* applyItem(item);
    }
    yield* applyEventBatch(events);
  });

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

  yield* setSynchronizing;
  // High-frequency streams (streaming text deltas) would otherwise run the
  // reducer, notify subscribers, and queue persistence once per network
  // event. Route items through a queue and drain everything that accumulated
  // while the previous batch applied: bursts collapse into one folded state
  // write with no added latency for isolated events.
  const streamQueue = yield* Queue.bounded<
    OrchestrationThreadStreamItem,
    EnvironmentRpcStreamFailure<typeof ORCHESTRATION_WS_METHODS.subscribeThread> | Cause.Done
  >(THREAD_STREAM_QUEUE_CAPACITY);
  yield* subscribe(
    ORCHESTRATION_WS_METHODS.subscribeThread,
    { threadId },
    {
      onExpectedFailure: setStreamError,
      retryExpectedFailureAfter: "250 millis",
    },
  ).pipe(Stream.runIntoQueue(streamQueue), Effect.forkScoped);
  yield* Queue.takeAll(streamQueue).pipe(
    Effect.flatMap((items) => applyItems(items)),
    Effect.forever,
    Effect.catchTag("Done", () => Effect.void),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() =>
    SubscriptionRef.get(state).pipe(
      Effect.flatMap((current) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: persist,
        }),
      ),
    ),
  );

  return state;
});

export function threadStateChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentThreadState(threadId).pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
