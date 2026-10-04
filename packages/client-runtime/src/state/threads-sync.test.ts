import {
  EnvironmentId,
  EventId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  MessageId,
  TurnId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import { TEST_SERVER_CONFIG } from "../../test/fixtures.ts";
import * as RpcSession from "../rpc/session.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  requestOlderThreadTurns,
  type EnvironmentThreadState,
} from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = ThreadId.make("thread-1");
const BASE_THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Cached thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

type TestThreadInput = OrchestrationThreadStreamItem | Error;

function testSession(client: WsRpcProtocolClient, paginated = false): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed({ ...TEST_SERVER_CONFIG, threadSnapshotPagination: paginated }),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function awaitThreadState(
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return Queue.take(observed).pipe(
    Effect.repeat({
      until: predicate,
    }),
  );
}

const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (options?: {
  readonly cached?: OrchestrationThread;
  readonly loadPage?: ThreadSnapshotLoader["Service"]["load"];
}) {
  const inputs = yield* Queue.unbounded<TestThreadInput>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
  const retryCount = yield* Ref.make(0);
  const subscriptionCount = yield* Ref.make(0);
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationThread>>([]);
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const streamFrom = (queue: Queue.Queue<TestThreadInput>) =>
    Stream.fromQueue(queue).pipe(
      Stream.mapEffect((input) =>
        input instanceof Error ? Effect.fail(input) : Effect.succeed(input),
      ),
    );
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
      Stream.unwrap(
        Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
          Effect.map(() => streamFrom(inputs)),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(testSession(client, options?.loadPage !== undefined)),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    options?.loadPage ? Option.some({} as PreparedConnection) : Option.none(),
  );
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      Effect.succeed(
        threadId === THREAD_ID && options?.cached !== undefined
          ? Option.some({ snapshotSequence: 0, thread: options.cached })
          : Option.none(),
      ),
    saveThread: (_environmentId, snapshot) =>
      Ref.update(savedThreads, (current) => [...current, snapshot.thread]),
    removeThread: (_environmentId, threadId) =>
      Ref.update(removedThreads, (current) => [...current, threadId]),
    clear: () => Effect.void,
  });
  const buildState = makeEnvironmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
  );
  const threadState = yield* options?.loadPage
    ? buildState.pipe(Effect.provideService(ThreadSnapshotLoader, { load: options.loadPage }))
    : buildState;
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) =>
      Ref.set(latest, state).pipe(Effect.andThen(Queue.offer(observed, state))),
    ),
    Effect.forkScoped,
  );

  return {
    inputs,
    observed,
    latest,
    retryCount,
    subscriptionCount,
    supervisorState,
    supervisorSession,
    savedThreads,
    removedThreads,
    replaceSession: SubscriptionRef.set(
      supervisorSession,
      Option.some(testSession(client, options?.loadPage !== undefined)),
    ),
  };
});

const snapshot = (thread: OrchestrationThread): OrchestrationThreadStreamItem => ({
  kind: "snapshot",
  snapshot: {
    snapshotSequence: 1,
    thread,
  },
});

const titleUpdated = (title: string, sequence = 2): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-title"),
    sequence,
    occurredAt: "2026-04-01T01:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.meta-updated",
    payload: {
      threadId: THREAD_ID,
      title,
      updatedAt: "2026-04-01T01:00:00.000Z",
    },
  },
});

const deleted = (): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-deleted"),
    sequence: 3,
    occurredAt: "2026-04-01T02:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.deleted",
    payload: {
      threadId: THREAD_ID,
      deletedAt: "2026-04-01T02:00:00.000Z",
    },
  },
});

describe("EnvironmentThreads", () => {
  it.effect(
    "merges an older page while later live deltas continue without lost prefixes or duplicate text",
    () =>
      Effect.gen(function* () {
        const response =
          yield* Deferred.make<
            Option.Option<import("@t3tools/contracts").OrchestrationThreadDetailSnapshot>
          >();
        const harness = yield* makeHarness({
          cached: BASE_THREAD,
          loadPage: () => Deferred.await(response),
        });
        const message = {
          id: MessageId.make("current"),
          role: "assistant" as const,
          text: "Current",
          turnId: TurnId.make("current-turn"),
          streaming: true,
          createdAt: BASE_THREAD.createdAt,
          updatedAt: BASE_THREAD.updatedAt,
        };
        yield* Queue.offer(harness.inputs, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: 1,
            thread: { ...BASE_THREAD, messages: [message] },
            page: {
              snapshotSequence: 1,
              threadSequence: 1,
              hasMore: true,
              beforeCursor: "earlier",
            },
          },
        });
        yield* awaitThreadState(
          harness.observed,
          (s) => Option.isSome(s.page) && s.page.value.hasMore,
        );
        expect(requestOlderThreadTurns(TARGET.environmentId, THREAD_ID)).toBe(true);
        yield* awaitThreadState(
          harness.observed,
          (s) => Option.isSome(s.page) && s.page.value.loadingOlder,
        );
        const base = titleUpdated("Unused", 2);
        if (base.kind !== "event") throw new Error("Event fixture missing");
        const delta = (
          sequence: number,
          id: string,
          turn: string,
          text: string,
        ): OrchestrationThreadStreamItem => ({
          kind: "event",
          event: {
            ...base.event,
            sequence,
            type: "thread.message-sent",
            payload: {
              threadId: THREAD_ID,
              messageId: MessageId.make(id),
              role: "assistant",
              text,
              turnId: TurnId.make(turn),
              streaming: true,
              createdAt: BASE_THREAD.createdAt,
              updatedAt: BASE_THREAD.updatedAt,
            },
          },
        });
        yield* Queue.offer(harness.inputs, delta(2, "old", "old-turn", " included"));
        yield* Queue.offer(harness.inputs, delta(3, "current", "current-turn", "!"));
        yield* Queue.offer(harness.inputs, delta(4, "old", "old-turn", " tail"));
        yield* Queue.offer(harness.inputs, titleUpdated("New metadata", 5));
        yield* awaitThreadState(
          harness.observed,
          (s) => Option.isSome(s.data) && s.data.value.title === "New metadata",
        );
        yield* Deferred.succeed(
          response,
          Option.some({
            snapshotSequence: 3,
            page: { snapshotSequence: 3, threadSequence: 2, hasMore: false, beforeCursor: null },
            thread: {
              ...BASE_THREAD,
              title: "Old metadata",
              messages: [
                {
                  ...message,
                  id: MessageId.make("old"),
                  turnId: TurnId.make("old-turn"),
                  text: "Old included",
                },
              ],
            },
          }),
        );
        const final = yield* awaitThreadState(
          harness.observed,
          (s) => Option.isSome(s.page) && !s.page.value.loadingOlder,
        );
        expect(Option.getOrThrow(final.data).messages.map((m) => m.text)).toEqual([
          "Old included tail",
          "Current!",
        ]);
        expect(Option.getOrThrow(final.data).title).toBe("New metadata");
      }),
  );

  it.effect("keeps explicitly loaded paged history intact as live messages arrive", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const messages = Array.from({ length: 600 }, (_, i) => ({
        id: MessageId.make(`history-${i}`),
        role: "user" as const,
        text: `History ${i}`,
        turnId: null,
        streaming: false,
        createdAt: BASE_THREAD.createdAt,
        updatedAt: BASE_THREAD.updatedAt,
      }));
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 1,
          thread: { ...BASE_THREAD, messages },
          page: { snapshotSequence: 1, threadSequence: 1, hasMore: false, beforeCursor: null },
        },
      });
      const fields = titleUpdated("Unused", 2);
      if (fields.kind !== "event") throw new Error("Event fixture missing");
      yield* Queue.offer(harness.inputs, {
        kind: "event",
        event: {
          ...fields.event,
          type: "thread.message-sent",
          payload: {
            threadId: THREAD_ID,
            messageId: MessageId.make("new-history-message"),
            role: "user",
            text: "New",
            turnId: null,
            streaming: false,
            createdAt: BASE_THREAD.createdAt,
            updatedAt: BASE_THREAD.updatedAt,
          },
        },
      } as OrchestrationThreadStreamItem);
      const state = yield* awaitThreadState(
        harness.observed,
        (state) =>
          Option.isSome(state.data) &&
          state.data.value.messages.some((m) => m.id === "new-history-message"),
      );
      expect(Option.getOrThrow(state.data).messages.length).toBe(601);
    }),
  );

  it.effect(
    "does not construct partial historical messages from deltas outside the loaded window",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Queue.offer(harness.inputs, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: 1,
            thread: BASE_THREAD,
            page: {
              snapshotSequence: 1,
              threadSequence: 1,
              hasMore: true,
              beforeCursor: "earlier",
            },
          },
        });
        const fields = titleUpdated("Unused", 2);
        if (fields.kind !== "event") throw new Error("Event fixture missing");
        yield* Queue.offer(harness.inputs, {
          kind: "event",
          event: {
            ...fields.event,
            type: "thread.message-sent",
            payload: {
              threadId: THREAD_ID,
              messageId: MessageId.make("unloaded-message"),
              role: "assistant",
              text: "partial delta",
              turnId: TurnId.make("unloaded-turn"),
              streaming: true,
              createdAt: BASE_THREAD.createdAt,
              updatedAt: BASE_THREAD.updatedAt,
            },
          },
        });
        yield* Queue.offer(harness.inputs, titleUpdated("After historical delta", 3));
        const state = yield* awaitThreadState(
          harness.observed,
          (state) =>
            Option.isSome(state.data) && state.data.value.title === "After historical delta",
        );
        expect(Option.getOrThrow(state.data).messages).toEqual([]);
      }),
  );

  it.effect(
    "reopens a paged detail subscription after a revert invalidates its history anchor",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Queue.offer(harness.inputs, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: 1,
            thread: BASE_THREAD,
            page: {
              snapshotSequence: 1,
              threadSequence: 1,
              hasMore: true,
              beforeCursor: "removed-anchor",
            },
          },
        });
        const fields = titleUpdated("Unused", 2);
        if (fields.kind !== "event") throw new Error("Event fixture missing");
        yield* Queue.offer(harness.inputs, {
          kind: "event",
          event: {
            ...fields.event,
            type: "thread.reverted",
            payload: { threadId: THREAD_ID, turnCount: 0 },
          },
        });
        for (let i = 0; i < 1000 && (yield* Ref.get(harness.subscriptionCount)) < 2; i++)
          yield* Effect.yieldNow;
        expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
        yield* Queue.offer(
          harness.inputs,
          snapshot({ ...BASE_THREAD, title: "After fresh history" }),
        );
        const state = yield* awaitThreadState(
          harness.observed,
          (state) => Option.isSome(state.data) && state.data.value.title === "After fresh history",
        );
        expect(Option.isNone(state.page)).toBe(true);
      }),
  );

  it.effect("publishes cached data before a live snapshot arrives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "cached" && Option.isSome(value.data),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
      expect(Option.isNone(state.error)).toBe(true);
    }),
  );

  it.effect("reduces live events and persists the latest thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title"));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.title).toBe("Live title");
    }),
  );

  it.effect("ignores replayed thread events at or below the snapshot sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, titleUpdated("Replayed title", 1));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
    }),
  );

  it.effect("removes cached data when the thread is deleted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, deleted());

      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
    }),
  );

  it.effect("preserves data after a domain failure and resumes on a replacement session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, new Error("stream failed"));

      const state = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
      expect(Option.getOrThrow(state.error)).toBe("stream failed");
      expect(yield* Ref.get(harness.retryCount)).toBe(0);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          title: "Recovered thread",
        }),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Recovered thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
    }),
  );

  it.effect("recovers from a transient domain failure without replacing the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, new Error("thread not found yet"));

      const failed = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );
      expect(Option.getOrThrow(failed.error)).toBe("thread not found yet");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* TestClock.adjust("250 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          title: "Materialized thread",
        }),
      );

      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Materialized thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
    }),
  );

  it.effect("does not overwrite a live snapshot when the supervisor becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("live");
    }),
  );

  it.effect("drain loop suspends while no stream items are buffered", () =>
    Effect.gen(function* () {
      // The consumer must block on an empty queue between stream arrivals;
      // a non-blocking drain would busy-spin per retained thread state.
      const queue = yield* Queue.unbounded<number, Cause.Done>();
      const batches = yield* Ref.make(0);
      const fiber = yield* Queue.takeAll(queue).pipe(
        Effect.flatMap(() => Ref.update(batches, (count) => count + 1)),
        Effect.forever,
        Effect.catchTag("Done", () => Effect.void),
        Effect.forkScoped,
      );

      for (let attempt = 0; attempt < 50; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(batches)).toBe(0);

      yield* Queue.offer(queue, 1);
      yield* Queue.offer(queue, 2);
      for (let attempt = 0; attempt < 50 && (yield* Ref.get(batches)) === 0; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(batches)).toBe(1);

      for (let attempt = 0; attempt < 50; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(batches)).toBe(1);
      yield* Fiber.interrupt(fiber);
    }),
  );
});
