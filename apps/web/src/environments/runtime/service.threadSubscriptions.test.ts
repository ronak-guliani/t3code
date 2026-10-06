import { QueryClient } from "@tanstack/react-query";
import {
  EnvironmentId,
  EventId,
  CheckpointRef,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  QueuedTurnId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { encodeThreadHistoryCursor } from "@t3tools/shared/threadHistoryState";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSubscribeThread = vi.fn();
const mockThreadUnsubscribe = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();
const mockWaitForSavedEnvironmentRegistryHydration = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockSavedEnvironmentRegistrySubscribe = vi.fn();

function MockWsTransport() {
  return undefined;
}

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: vi.fn(() => ({
    id: "env-1",
    label: "Primary environment",
    source: "window-origin",
    target: {
      httpBaseUrl: "http://127.0.0.1:3000/",
      wsBaseUrl: "ws://127.0.0.1:3000/",
    },
    environmentId: EnvironmentId.make("env-1"),
  })),
  waitForPrimaryAuthentication: vi.fn(async () => undefined),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: vi.fn(),
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: vi.fn(),
  readSavedEnvironmentBearerToken: vi.fn(),
  removeSavedEnvironmentBearerToken: vi.fn(),
  useSavedEnvironmentRegistryStore: {
    subscribe: mockSavedEnvironmentRegistrySubscribe,
    getState: () => ({
      upsert: vi.fn(),
      remove: vi.fn(),
      markConnected: vi.fn(),
    }),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      ensure: vi.fn(),
      patch: vi.fn(),
      clear: vi.fn(),
    }),
  },
  waitForSavedEnvironmentRegistryHydration: mockWaitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken: vi.fn(),
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("../../rpc/wsRpcClient", () => ({
  createWsRpcClient: mockCreateWsRpcClient,
}));

vi.mock("../../rpc/wsTransport", () => ({
  WsTransport: MockWsTransport,
}));

function makeThreadShellSnapshot(params: {
  readonly threadId: ThreadId;
  readonly sessionStatus?:
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error";
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly hasActionableProposedPlan?: boolean;
  readonly hasPendingQueuedTurn?: boolean;
}): OrchestrationShellSnapshot {
  const projectId = ProjectId.make("project-1");
  const turnId = TurnId.make("turn-1");

  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: "2026-04-13T00:00:00.000Z",
    threads: [
      {
        id: params.threadId,
        projectId,
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        pendingRuntimeMode: null,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn:
          params.sessionStatus === "running"
            ? {
                turnId,
                state: "running",
                requestedAt: "2026-04-13T00:00:00.000Z",
                startedAt: "2026-04-13T00:00:01.000Z",
                completedAt: null,
                assistantMessageId: null,
              }
            : null,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
        archivedAt: null,
        session: params.sessionStatus
          ? {
              threadId: params.threadId,
              status: params.sessionStatus,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: params.sessionStatus === "running" ? turnId : null,
              lastError: null,
              updatedAt: "2026-04-13T00:00:00.000Z",
            }
          : null,
        latestUserMessageAt: null,
        hasPendingApprovals: params.hasPendingApprovals ?? false,
        hasPendingUserInput: params.hasPendingUserInput ?? false,
        hasActionableProposedPlan: params.hasActionableProposedPlan ?? false,
        hasPendingQueuedTurn: params.hasPendingQueuedTurn ?? false,
      },
    ],
  };
}

function makeShellSnapshotForThreads(
  threadIds: ReadonlyArray<ThreadId>,
  snapshotSequence = 1,
): OrchestrationShellSnapshot {
  return {
    ...makeThreadShellSnapshot({ threadId: ThreadId.make("placeholder") }),
    snapshotSequence,
    threads: threadIds.flatMap((threadId) => makeThreadShellSnapshot({ threadId }).threads),
  };
}

function makeOrchestrationThread(threadId: ThreadId, title: string): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function metaUpdatedEvent(threadId: ThreadId, sequence: number, title: string): OrchestrationEvent {
  return {
    eventId: EventId.make(`event-${sequence}`),
    sequence,
    occurredAt: "2026-04-13T00:01:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.meta-updated",
    payload: {
      threadId,
      title,
      updatedAt: "2026-04-13T00:01:00.000Z",
    },
  };
}

describe("retainThreadDetailSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();

    mockThreadUnsubscribe.mockImplementation(() => undefined);
    mockSubscribeThread.mockImplementation(() => mockThreadUnsubscribe);
    mockCreateWsRpcClient.mockReturnValue({
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });
    mockCreateEnvironmentConnection.mockImplementation((input) => ({
      kind: input.kind,
      environmentId: input.knownEnvironment.environmentId,
      knownEnvironment: input.knownEnvironment,
      client: input.client,
      ensureBootstrapped: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    }));
    mockSavedEnvironmentRegistrySubscribe.mockReturnValue(() => undefined);
    mockWaitForSavedEnvironmentRegistryHydration.mockResolvedValue(undefined);
    mockListSavedEnvironmentRecords.mockReturnValue([]);
  });

  afterEach(async () => {
    const { resetEnvironmentServiceForTests } = await import("./service");
    await resetEnvironmentServiceForTests();
    vi.useRealTimers();
  });

  // Older-page I/O may overlap current streaming text and historical deltas.
  async function pagedHarness(getThreadSnapshot: ReturnType<typeof vi.fn>) {
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: async () => ({
          threadSnapshotPagination: true,
          threadResumeCompletionMarker: true,
        }),
      },
      orchestration: { subscribeThread: mockSubscribeThread, getThreadSnapshot },
    });
    const service = await import("./service");
    const store = await import("~/store");
    const stop = service.startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1"),
      threadId = ThreadId.make("paging-review");
    mockCreateEnvironmentConnection.mock.calls[0]![0].syncShellSnapshot(
      makeShellSnapshotForThreads([threadId]),
      environmentId,
    );
    const release = service.retainThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(0);
    const thread = {
      ...makeOrchestrationThread(threadId, "Paged"),
      messages: Array.from({ length: 10 }, (_, i) => ({
        id: MessageId.make(`recent-user-${i}`),
        role: "user" as const,
        text: "Recent user",
        turnId: null,
        streaming: false,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      })),
    };
    const listener = () =>
      mockSubscribeThread.mock.calls.at(-1)![1] as (item: OrchestrationThreadStreamItem) => void;
    listener()({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        thread,
        page: {
          snapshotSequence: 10,
          threadSequence: 10,
          hasMore: true,
          beforeCursor: "old-anchor",
        },
      },
    });
    const page = () =>
      store.selectEnvironmentState(store.useStore.getState(), environmentId).threadHistoryById?.[
        threadId
      ];
    return { service, store, stop, release, environmentId, threadId, thread, listener, page };
  }

  it("recovers a removed anchor with a fresh window instead of retrying it forever", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("The anchor vanished"), { reason: "history-cursor-stale" }),
      );
    const h = await pagedHarness(get);
    const request = h.service
      .loadOlderThreadHistory(h.environmentId, h.threadId)
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    h.listener()({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 12,
        thread: h.thread,
        page: {
          snapshotSequence: 12,
          threadSequence: 12,
          hasMore: true,
          beforeCursor: "fresh-anchor",
        },
      },
    });
    await request;
    expect(h.page()?.beforeCursor).toBe("fresh-anchor");
    expect(h.page()?.loadingOlder).toBe(false);
    expect(h.page()?.error).toBeNull();
    h.stop();
  });

  it("bounds a parked older-page wait and leaves it retryable", async () => {
    const h = await pagedHarness(
      vi.fn(async () => ({
        snapshotSequence: 100,
        thread: makeOrchestrationThread(ThreadId.make("paging-review"), "Parked"),
        page: { snapshotSequence: 100, threadSequence: 20, hasMore: false, beforeCursor: null },
      })),
    );
    let failure: string | null = null;
    const request = h.service.loadOlderThreadHistory(h.environmentId, h.threadId).catch((error) => {
      failure = error.message;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.page()?.loadingOlder).toBe(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(failure).toMatch(/timed out|unavailable/i);
    expect(h.page()?.loadingOlder).toBe(false);
    h.stop();
    await request;
  });

  it("refreshes a modern unknown message without first-message provenance instead of constructing a partial row", async () => {
    const h = await pagedHarness(vi.fn());
    h.listener()({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        thread: h.thread,
        page: {
          snapshotSequence: 10,
          threadSequence: 10,
          hasMore: true,
          beforeCursor: "old-anchor",
          windowStart: { sequence: 5, rowId: 5 },
        },
      },
    });
    h.listener()({
      kind: "event",
      event: {
        ...metaUpdatedEvent(h.threadId, 11, "Unused"),
        type: "thread.message-sent",
        payload: {
          threadId: h.threadId,
          messageId: MessageId.make("missing-provenance"),
          role: "assistant",
          turnId: TurnId.make("old-turn"),
          text: "tail",
          streaming: true,
          createdAt: h.thread.createdAt,
          updatedAt: h.thread.updatedAt,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    expect(
      h.store
        .selectThreadByRef(h.store.useStore.getState(), {
          environmentId: h.environmentId,
          threadId: h.threadId,
        })
        ?.messages.some((m) => m.id === "missing-provenance"),
    ).toBe(false);
    h.stop();
  });

  it("clears a canceled request's spinner and reports unavailable full-history reads", async () => {
    let resolve!: (snapshot: unknown) => void;
    const h = await pagedHarness(
      vi.fn(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    );
    let settled = false;
    const request = h.service.loadOlderThreadHistory(h.environmentId, h.threadId).then(() => {
      settled = true;
    });
    expect(h.page()?.loadingOlder).toBe(true);
    h.release();
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
    expect(settled).toBe(true);
    resolve({
      snapshotSequence: 10,
      thread: h.thread,
      page: { snapshotSequence: 10, threadSequence: 10, hasMore: false, beforeCursor: null },
    });
    await request;
    expect(h.page()?.loadingOlder).toBe(false);
    await expect(
      h.service.loadCompleteThreadHistory(h.environmentId, h.threadId),
    ).rejects.toThrow();
    h.stop();
  });

  it.each(["revert", "replacement"] as const)(
    "settles complete-history loading after %s without an obsolete RPC response",
    async (reason) => {
      const h = await pagedHarness(vi.fn(() => new Promise(() => undefined)));
      let settled = false;
      const request = h.service.loadCompleteThreadHistory(h.environmentId, h.threadId).then(() => {
        settled = true;
      });
      if (reason === "revert") {
        h.listener()({
          kind: "event",
          event: {
            ...metaUpdatedEvent(h.threadId, 11, "Unused"),
            type: "thread.reverted",
            payload: { threadId: h.threadId, turnCount: 10 },
          },
        });
        await vi.advanceTimersByTimeAsync(0);
      }
      h.listener()({
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 12,
          thread: h.thread,
          page: { snapshotSequence: 12, threadSequence: 12, hasMore: false, beforeCursor: null },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await request;
      expect(h.page()?.loadingOlder).toBe(false);
      expect(h.page()?.hasMore).toBe(false);
      h.stop();
    },
  );

  it("requests the previously loaded depth after a revert invalidates the cursor", async () => {
    const h = await pagedHarness(
      vi.fn(async () => ({
        snapshotSequence: 10,
        thread: {
          ...makeOrchestrationThread(ThreadId.make("paging-review"), "Older"),
          messages: Array.from({ length: 20 }, (_, i) => ({
            ...h.thread.messages[0]!,
            id: MessageId.make(`older-user-${i}`),
          })),
        },
        page: {
          snapshotSequence: 10,
          threadSequence: 10,
          hasMore: true,
          beforeCursor: "previous-depth",
        },
      })),
    );
    await h.service.loadOlderThreadHistory(h.environmentId, h.threadId);
    h.listener()({
      kind: "event",
      event: {
        ...metaUpdatedEvent(h.threadId, 11, "Unused"),
        type: "thread.reverted",
        payload: { threadId: h.threadId, turnCount: 25 },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const input = mockSubscribeThread.mock.calls.at(-1)![0];
    expect(typeof input === "function" ? input() : input).toMatchObject({ turnLimit: 30 });
    h.stop();
  });

  it.each(["stream", "buffered page"] as const)(
    "recovers an evicted turn during %s",
    async (mode) => {
      const getThreadSnapshot = vi.fn();
      const h = await pagedHarness(getThreadSnapshot);
      const messages: Array<OrchestrationThread["messages"][number]> = [];
      const userOrigins: Record<string, { sequence: number; rowId: number }> = {};
      const turnCount = 20;
      const messagesPerTurn = 105;
      for (let turn = 0; turn < turnCount; turn++) {
        const turnId = TurnId.make(`wide-turn-${turn}`);
        const userId = MessageId.make(`wide-user-${turn}`);
        const firstSequence = turn * messagesPerTurn + 1;
        userOrigins[userId] = { sequence: firstSequence, rowId: firstSequence };
        messages.push({
          id: userId,
          role: "user",
          text: `Prompt ${turn}`,
          turnId,
          streaming: false,
          createdAt: "2026-10-04T00:00:00.000Z",
          updatedAt: "2026-10-04T00:00:00.000Z",
        });
        for (let segment = 1; segment < messagesPerTurn; segment++) {
          messages.push({
            id: MessageId.make(`wide-assistant-${turn}-${segment}`),
            role: "assistant",
            text: `Response ${turn}.${segment}`,
            turnId,
            streaming: false,
            createdAt: "2026-10-04T00:00:00.000Z",
            updatedAt: "2026-10-04T00:00:00.000Z",
          });
        }
      }
      const initialCursor = encodeThreadHistoryCursor(h.threadId, "wide-user-0");
      let resolvePage: (() => void) | undefined;
      let request: Promise<void> | undefined;
      if (mode === "buffered page") {
        getThreadSnapshot.mockImplementation(
          (input: { beforeCursor: string }) =>
            new Promise((resolve) => {
              resolvePage = () =>
                resolve({
                  snapshotSequence: 5002,
                  thread: {
                    ...h.thread,
                    messages:
                      input.beforeCursor === encodeThreadHistoryCursor(h.threadId, "wide-user-1")
                        ? messages.slice(0, messagesPerTurn)
                        : [],
                  },
                  page: {
                    snapshotSequence: 5002,
                    threadSequence: 5002,
                    beforeCursor: null,
                    hasMore: false,
                    windowStart: null,
                    userOrigins: { "wide-user-0": userOrigins["wide-user-0"] },
                  },
                });
            }),
        );
      }
      h.listener()({
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 5000,
          thread: { ...h.thread, messages },
          page: {
            snapshotSequence: 5000,
            threadSequence: 5000,
            beforeCursor: initialCursor,
            hasMore: true,
            windowStart: { sequence: 1, rowId: 1 },
            userOrigins,
          },
        },
      });
      const mergedPager = h.page();
      expect(mergedPager?.retention?.messages).toBe(messages.length);
      expect(mergedPager?.beforeCursor).toBe(initialCursor);
      if (mode === "buffered page") {
        const lastMessage = messages.at(-1)!;
        h.listener()({
          kind: "event",
          messageOrigin: { sequence: messages.length, rowId: messages.length },
          event: {
            ...metaUpdatedEvent(h.threadId, 5001, "Unused"),
            type: "thread.message-sent",
            payload: {
              threadId: h.threadId,
              messageId: lastMessage.id,
              role: "assistant",
              text: "Live delta",
              turnId: lastMessage.turnId,
              streaming: true,
              createdAt: lastMessage.createdAt,
              updatedAt: lastMessage.updatedAt,
            },
          },
        });
      }

      h.listener()({
        kind: "event",
        messageOrigin: { sequence: 5002, rowId: messages.length + 1 },
        event: {
          ...metaUpdatedEvent(h.threadId, 5002, "Unused"),
          type: "thread.message-sent",
          payload: {
            threadId: h.threadId,
            messageId: MessageId.make("wide-user-next"),
            role: "user",
            text: "Next prompt",
            turnId: TurnId.make("wide-turn-next"),
            streaming: false,
            createdAt: "2026-10-04T00:00:00.000Z",
            updatedAt: "2026-10-04T00:00:00.000Z",
          },
        },
      });
      if (mode === "buffered page")
        request = h.service.loadOlderThreadHistory(h.environmentId, h.threadId);
      await vi.advanceTimersByTimeAsync(0);
      const page = h.page();
      expect(page?.beforeCursor).toBe(encodeThreadHistoryCursor(h.threadId, "wide-user-1"));
      expect(page?.hasMore).toBe(true);
      expect(page?.userOrigins?.["wide-user-0"]).toBeUndefined();
      expect(page?.userOrigins?.["wide-user-1"]).toEqual({ sequence: 106, rowId: 106 });
      if (mode === "stream") expect(getThreadSnapshot).not.toHaveBeenCalled();
      else {
        resolvePage?.();
        await request;
        expect(
          h.store
            .selectThreadByRef(h.store.useStore.getState(), {
              environmentId: h.environmentId,
              threadId: h.threadId,
            })
            ?.messages.some((message) => message.id === "wide-user-0"),
        ).toBe(true);
        expect(h.page()?.hasMore).toBe(false);
      }
      h.stop();
    },
  );

  // The page owns its watermark, but loaded metadata/current text stay newer.
  it("merges older turns without duplicating streamed text or replacing live metadata", async () => {
    const service = await import("./service");
    const { selectThreadByRef, selectEnvironmentState, useStore } = await import("~/store");
    let resolvePage!: (page: unknown) => void;
    const getThreadSnapshot = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
    );
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: async () => ({
          threadSnapshotPagination: true,
          threadResumeCompletionMarker: true,
        }),
      },
      orchestration: { subscribeThread: mockSubscribeThread, getThreadSnapshot },
    });
    const stop = service.startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1"),
      threadId = ThreadId.make("history-stream");
    const ref = { environmentId, threadId };
    mockCreateEnvironmentConnection.mock.calls[0]![0].syncShellSnapshot(
      makeShellSnapshotForThreads([threadId]),
      environmentId,
    );
    service.retainThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(0);
    const input = mockSubscribeThread.mock.calls.at(-1)![0];
    expect(typeof input === "function" ? input() : input).toMatchObject({
      threadId,
      turnLimit: 10,
    });
    const listener = mockSubscribeThread.mock.calls.at(-1)![1] as (
      item: OrchestrationThreadStreamItem,
    ) => void;
    const current = makeOrchestrationThread(threadId, "Current");
    const newMessage = {
      id: MessageId.make("new-message"),
      role: "assistant" as const,
      text: "New",
      turnId: TurnId.make("new-turn"),
      streaming: true,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
    };
    listener({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        thread: { ...current, messages: [newMessage] },
        page: {
          snapshotSequence: 10,
          threadSequence: 10,
          hasMore: true,
          beforeCursor: "older",
          windowStart: { sequence: 10, rowId: 10 },
        },
      },
    });
    const loading = service.loadOlderThreadHistory(environmentId, threadId);
    const pageCoherence: Array<{
      messageCount: number;
      beforeCursor: string | null;
      hasMore: boolean;
      loadingOlder: boolean;
    }> = [];
    const unsubscribeCoherence = useStore.subscribe((state) => {
      const thread = selectThreadByRef(state, ref);
      if (!thread?.messages.some((message) => message.id === "page-only-message")) return;
      const page = selectEnvironmentState(state, environmentId).threadHistoryById?.[threadId];
      if (page)
        pageCoherence.push({
          messageCount: thread.messages.length,
          beforeCursor: page.beforeCursor,
          hasMore: page.hasMore,
          loadingOlder: page.loadingOlder,
        });
    });
    expect(getThreadSnapshot).toHaveBeenCalledWith({
      threadId,
      turnLimit: 20,
      beforeCursor: "older",
    });
    const delta = (
      sequence: number,
      messageId: string,
      turnId: string,
      text: string,
    ): OrchestrationEvent => ({
      ...metaUpdatedEvent(threadId, sequence, "Unused"),
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId: MessageId.make(messageId),
        role: "assistant",
        text,
        turnId: TurnId.make(turnId),
        streaming: true,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      },
    });
    listener({
      kind: "event",
      event: delta(11, "old-message", "old-turn", " included"),
      messageOrigin: { sequence: 1, rowId: 1 },
    });
    listener({ kind: "event", event: delta(12, "new-message", "new-turn", "!") });
    listener({ kind: "event", event: metaUpdatedEvent(threadId, 13, "Updated while paging") });
    listener({
      kind: "event",
      event: delta(14, "old-message", "old-turn", " tail"),
      messageOrigin: { sequence: 1, rowId: 1 },
    });
    await vi.advanceTimersByTimeAsync(32);
    resolvePage({
      snapshotSequence: 12,
      page: { snapshotSequence: 12, threadSequence: 11, hasMore: false, beforeCursor: null },
      thread: {
        ...current,
        title: "Stale metadata",
        messages: [
          {
            ...newMessage,
            id: MessageId.make("page-only-message"),
            role: "user",
            turnId: TurnId.make("old-turn"),
            text: "Older page row",
          },
          {
            ...newMessage,
            id: MessageId.make("old-message"),
            turnId: TurnId.make("old-turn"),
            text: "Old included",
          },
        ],
      },
    });
    await loading;
    unsubscribeCoherence();
    const loaded = selectThreadByRef(useStore.getState(), ref)!;
    expect(loaded.messages.map((message) => message.text)).toEqual([
      "Older page row",
      "Old included tail",
      "New!",
    ]);
    expect(loaded.title).toBe("Updated while paging");
    expect(
      selectEnvironmentState(useStore.getState(), environmentId).threadHistoryById?.[threadId],
    ).toMatchObject({ hasMore: false, loadingOlder: false });
    expect(pageCoherence).toEqual([
      { messageCount: 3, beforeCursor: null, hasMore: false, loadingOlder: false },
    ]);
    stop();
    await service.resetEnvironmentServiceForTests();
  });

  it("discards an older-page response when a new authoritative snapshot rewrites history", async () => {
    const service = await import("./service");
    const { selectThreadByRef, useStore } = await import("~/store");
    let resolvePage!: (page: unknown) => void;
    mockCreateWsRpcClient.mockReturnValue({
      orchestration: {
        subscribeThread: mockSubscribeThread,
        getThreadSnapshot: vi.fn(
          () =>
            new Promise((resolve) => {
              resolvePage = resolve;
            }),
        ),
      },
    });
    const stop = service.startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1"),
      threadId = ThreadId.make("rewritten-history");
    mockCreateEnvironmentConnection.mock.calls[0]![0].syncShellSnapshot(
      makeShellSnapshotForThreads([threadId]),
      environmentId,
    );
    service.retainThreadDetailSubscription(environmentId, threadId);
    const listener = mockSubscribeThread.mock.calls.at(-1)![1] as (
      item: OrchestrationThreadStreamItem,
    ) => void;
    const thread = makeOrchestrationThread(threadId, "Before");
    listener({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        thread,
        page: { snapshotSequence: 10, threadSequence: 10, hasMore: true, beforeCursor: "old" },
      },
    });
    const loading = service.loadOlderThreadHistory(environmentId, threadId);
    listener({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 20,
        thread: { ...thread, title: "After revert" },
        page: { snapshotSequence: 20, threadSequence: 20, hasMore: false, beforeCursor: null },
      },
    });
    resolvePage({
      snapshotSequence: 11,
      thread: { ...thread, title: "Removed history" },
      page: { snapshotSequence: 11, threadSequence: 11, hasMore: false, beforeCursor: null },
    });
    await loading;
    expect(selectThreadByRef(useStore.getState(), { environmentId, threadId })?.title).toBe(
      "After revert",
    );
    stop();
    await service.resetEnvironmentServiceForTests();
  });

  it("keeps thread detail subscriptions warm across releases until idle eviction", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-1");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads([threadId]), environmentId);

    const releaseFirst = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    const releaseSecond = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(28 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("waits for the shell projection before opening a thread detail subscription", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-unprojected");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    // Subscribing before the thread is projected makes the server reject the
    // stream, which parks it permanently and leaves the chat frozen.
    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).not.toHaveBeenCalled();

    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads([threadId]), environmentId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps retained thread detail subscriptions when a shell snapshot omits the thread", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-live");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads([threadId]), environmentId);
    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads([], 2), environmentId);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reports active thread work only while a retained thread is non-idle", async () => {
    const {
      hasActiveThreadDetailWork,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-work");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "running" }),
      environmentId,
    );
    expect(hasActiveThreadDetailWork()).toBe(false);

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(hasActiveThreadDetailWork()).toBe(true);

    release();
    expect(hasActiveThreadDetailWork()).toBe(false);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("resubscribes retained non-idle threads on stall repair", async () => {
    const {
      repairActiveThreadDetailSubscriptionsAfterStall,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const activeThreadId = ThreadId.make("thread-stall-active");
    const idleThreadId = ThreadId.make("thread-stall-idle");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId: idleThreadId, sessionStatus: "idle" }),
      environmentId,
    );
    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId: activeThreadId,
          sessionStatus: "running",
        }).threads[0]!,
      },
      environmentId,
    );

    const releaseActive = retainThreadDetailSubscription(environmentId, activeThreadId);
    const releaseIdle = retainThreadDetailSubscription(environmentId, idleThreadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(2);

    // The active subscription is torn down and re-attached, the idle one untouched.
    const repair = repairActiveThreadDetailSubscriptionsAfterStall(environmentId);
    expect(repair).toEqual({ retained: 1, resubscribed: 1 });
    expect(mockSubscribeThread).toHaveBeenCalledTimes(3);

    releaseActive();
    releaseIdle();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps non-idle thread detail subscriptions attached until the thread becomes idle", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
        hasPendingApprovals: true,
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId,
          sessionStatus: "idle",
        }).threads[0]!,
      },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("clears pending send status from shell turn acknowledgement", async () => {
    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");
    const { usePendingTurnStore } = await import("~/pendingTurnStore");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-pending-shell");
    const threadRef = { environmentId, threadId };
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "idle",
      }),
      environmentId,
    );
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId,
          sessionStatus: "running",
        }).threads[0]!,
      },
      environmentId,
    );

    expect(usePendingTurnStore.getState().pendingByThreadKey).toEqual({});

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("clears shared pending state for threads removed by shell snapshot sync", async () => {
    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");
    const { usePendingTurnStore } = await import("~/pendingTurnStore");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-removed-by-snapshot");
    const threadRef = { environmentId, threadId };
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    const initialSnapshot = makeThreadShellSnapshot({ threadId, sessionStatus: "idle" });
    connectionInput.syncShellSnapshot(initialSnapshot, environmentId);
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);
    usePendingTurnStore.getState().addOptimisticMessage(threadRef, {
      id: MessageId.make("message-1"),
      role: "user",
      text: "Ship it",
      createdAt: "2026-04-13T00:00:00.000Z",
      streaming: false,
    });

    connectionInput.syncShellSnapshot(
      {
        ...initialSnapshot,
        snapshotSequence: 2,
        threads: [],
      },
      environmentId,
    );

    expect(usePendingTurnStore.getState().pendingByThreadKey).toEqual({});
    expect(usePendingTurnStore.getState().optimisticMessagesByThreadKey).toEqual({});

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("clears shared pending state when a shell event removes the thread", async () => {
    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");
    const { usePendingTurnStore } = await import("~/pendingTurnStore");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-removed-by-event");
    const threadRef = { environmentId, threadId };
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({ threadId, sessionStatus: "idle" }),
      environmentId,
    );
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);
    usePendingTurnStore.getState().addOptimisticMessage(threadRef, {
      id: MessageId.make("message-1"),
      role: "user",
      text: "Ship it",
      createdAt: "2026-04-13T00:00:00.000Z",
      streaming: false,
    });

    connectionInput.applyShellEvent(
      {
        kind: "thread-removed",
        sequence: 2,
        threadId,
      },
      environmentId,
    );

    expect(usePendingTurnStore.getState().pendingByThreadKey).toEqual({});
    expect(usePendingTurnStore.getState().optimisticMessagesByThreadKey).toEqual({});

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("allows a larger idle cache before capacity eviction starts", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadIds = Array.from({ length: 12 }, (_, index) =>
      ThreadId.make(`thread-${index + 1}`),
    );
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads(threadIds), environmentId);

    for (const threadId of threadIds) {
      const release = retainThreadDetailSubscription(environmentId, threadId);
      release();
    }

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("disposes cached thread detail subscriptions when the environment service resets", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { selectEnvironmentState, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-2");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads([threadId]), environmentId);

    const release = retainThreadDetailSubscription(environmentId, threadId);
    release();

    const listener = mockSubscribeThread.mock.calls.at(-1)?.[1] as
      | ((item: OrchestrationThreadStreamItem) => void)
      | undefined;
    if (listener === undefined) {
      throw new Error("subscribeThread listener was not captured");
    }
    listener({
      kind: "snapshot",
      snapshot: { snapshotSequence: 10, thread: makeOrchestrationThread(threadId, "Hydrated") },
    });
    expect(
      selectEnvironmentState(useStore.getState(), environmentId).threadDetailHydratedById?.[
        threadId
      ],
    ).toBe(true);

    await resetEnvironmentServiceForTests();
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    expect(
      selectEnvironmentState(useStore.getState(), environmentId).threadDetailHydratedById?.[
        threadId
      ],
    ).toBeUndefined();

    stop();
  });

  // Queue/start transitions are user-visible acknowledgements, not token
  // deltas. They must flush older buffered events without reordering them.
  it.each(["user", "monitor", "cross-thread"] as const)(
    "applies %s queue and starting transitions without the stream coalescing delay",
    async (source) => {
      const {
        retainThreadDetailSubscription,
        startEnvironmentConnectionService,
        resetEnvironmentServiceForTests,
      } = await import("./service");
      const { selectThreadByRef, useStore } = await import("~/store");
      const stop = startEnvironmentConnectionService(new QueryClient());
      const environmentId = EnvironmentId.make("env-1");
      const threadId = ThreadId.make("thread-immediate-queue");
      const threadRef = { environmentId, threadId };
      const input = mockCreateEnvironmentConnection.mock.calls[0]![0];
      input.syncShellSnapshot(makeShellSnapshotForThreads([threadId]), environmentId);
      retainThreadDetailSubscription(environmentId, threadId);
      const listener = mockSubscribeThread.mock.calls.at(-1)![1] as (
        item: OrchestrationThreadStreamItem,
      ) => void;
      listener({
        kind: "snapshot",
        snapshot: { snapshotSequence: 10, thread: makeOrchestrationThread(threadId, "Base") },
      });
      listener({ kind: "event", event: metaUpdatedEvent(threadId, 11, "Leading") });
      listener({ kind: "event", event: metaUpdatedEvent(threadId, 12, "Buffered") });
      const base = metaUpdatedEvent(threadId, 13, "Unused");
      const messageId = MessageId.make("immediate-queued-message");
      const queuedTurnId = QueuedTurnId.make("immediate-queued-turn");
      listener({
        kind: "event",
        event: {
          ...base,
          type: "thread.queued-turn-created",
          payload: {
            threadId,
            queuedTurn: {
              id: queuedTurnId,
              threadId,
              message: { messageId, role: "user", text: "Immediate queue", attachments: [] },
              ...(source === "monitor"
                ? {
                    origin: {
                      kind: "pull-request-monitor" as const,
                      repository: "acme/app",
                      number: 42,
                    },
                  }
                : source === "cross-thread"
                  ? {
                      origin: {
                        kind: "cross-thread" as const,
                        sourceThreadId: ThreadId.make("source-thread"),
                        sourceMessageId: MessageId.make("source-message"),
                        sourceThreadTitle: "Source",
                      },
                    }
                  : {}),
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: base.occurredAt,
              updatedAt: base.occurredAt,
              failedAt: null,
              failureMessage: null,
            },
          },
        },
      });
      expect(selectThreadByRef(useStore.getState(), threadRef)?.title).toBe("Buffered");
      expect(selectThreadByRef(useStore.getState(), threadRef)?.queuedTurns?.[0]?.id).toBe(
        queuedTurnId,
      );
      listener({
        kind: "event",
        event: {
          ...base,
          sequence: 14,
          type: "thread.turn-start-requested",
          payload: {
            threadId,
            messageId,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: base.occurredAt,
          },
        },
      });
      listener({
        kind: "event",
        event: {
          ...base,
          sequence: 15,
          type: "thread.queued-turn-dispatched",
          payload: { threadId, queuedTurnId, messageId, dispatchedAt: base.occurredAt },
        },
      });
      expect(selectThreadByRef(useStore.getState(), threadRef)?.pendingTurnStart?.messageId).toBe(
        messageId,
      );
      expect(selectThreadByRef(useStore.getState(), threadRef)?.queuedTurns ?? []).toHaveLength(0);
      stop();
      await resetEnvironmentServiceForTests();
    },
  );

  it("applies streamed thread events immediately, then buffered bursts once", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { selectThreadByRef, useStore } = await import("~/store");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-stream");
    const threadRef = { environmentId, threadId };
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    connectionInput.syncShellSnapshot(makeShellSnapshotForThreads([threadId]), environmentId);

    retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    const listener = mockSubscribeThread.mock.calls.at(-1)?.[1] as
      | ((item: OrchestrationThreadStreamItem) => void)
      | undefined;
    if (listener === undefined) {
      throw new Error("subscribeThread listener was not captured");
    }

    listener({
      kind: "snapshot",
      snapshot: { snapshotSequence: 10, thread: makeOrchestrationThread(threadId, "Base title") },
    });
    expect(selectThreadByRef(useStore.getState(), threadRef)?.title).toBe("Base title");

    // The first event of a burst applies synchronously.
    listener({ kind: "event", event: metaUpdatedEvent(threadId, 11, "First title") });
    expect(selectThreadByRef(useStore.getState(), threadRef)?.title).toBe("First title");

    // Trailing burst events are held for the coalescing window.
    listener({ kind: "event", event: metaUpdatedEvent(threadId, 12, "Second title") });
    listener({ kind: "event", event: metaUpdatedEvent(threadId, 13, "Third title") });
    expect(selectThreadByRef(useStore.getState(), threadRef)?.title).toBe("First title");

    await vi.advanceTimersByTimeAsync(32);
    expect(selectThreadByRef(useStore.getState(), threadRef)?.title).toBe("Third title");

    // A snapshot flushes buffered events before replacing state.
    listener({ kind: "event", event: metaUpdatedEvent(threadId, 14, "Buffered title") });
    listener({
      kind: "snapshot",
      snapshot: { snapshotSequence: 15, thread: makeOrchestrationThread(threadId, "Snapshotted") },
    });
    expect(selectThreadByRef(useStore.getState(), threadRef)?.title).toBe("Snapshotted");

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("flushes coalesced replay events before advancing the synchronized watermark", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { selectThreadByRef, useStore } = await import("~/store");
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: async () => ({
          threadSnapshotPagination: true,
          threadResumeCompletionMarker: true,
        }),
      },
      orchestration: { subscribeThread: mockSubscribeThread },
    });
    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-replay-marker");
    const threadRef = { environmentId, threadId };
    mockCreateEnvironmentConnection.mock.calls[0]?.[0].syncShellSnapshot(
      makeShellSnapshotForThreads([threadId]),
      environmentId,
    );
    retainThreadDetailSubscription(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(0);
    const listener = mockSubscribeThread.mock.calls.at(-1)?.[1] as
      | ((item: OrchestrationThreadStreamItem) => void)
      | undefined;
    if (!listener) throw new Error("subscribeThread listener was not captured");
    listener({
      kind: "snapshot",
      snapshot: { snapshotSequence: 20, thread: makeOrchestrationThread(threadId, "base") },
    });
    const messageEvent = (
      sequence: number,
      messageId: string,
      role: "user" | "assistant",
      text: string,
    ) =>
      ({
        ...metaUpdatedEvent(threadId, sequence, "Unused"),
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId: MessageId.make(messageId),
          role,
          text,
          turnId: TurnId.make("turn-replay"),
          streaming: role === "assistant",
          createdAt: "2026-10-04T00:00:00.000Z",
          updatedAt: "2026-10-04T00:00:00.000Z",
        },
      }) as Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
    listener({ kind: "event", event: messageEvent(21, "replay-user", "user", "Prompt") });
    listener({ kind: "event", event: messageEvent(22, "replay-assistant", "assistant", "Answer") });
    listener({
      kind: "event",
      event: messageEvent(23, "replay-assistant", "assistant", " continued"),
    });
    listener({
      kind: "event",
      event: {
        ...metaUpdatedEvent(threadId, 24, "Unused"),
        type: "thread.activity-appended",
        payload: {
          threadId,
          activity: {
            id: EventId.make("replay-activity"),
            tone: "info",
            kind: "runtime.info",
            summary: "Replayed activity",
            payload: {},
            turnId: TurnId.make("turn-replay"),
            sequence: 24,
            createdAt: "2026-10-04T00:00:00.000Z",
          },
        },
      } as Extract<OrchestrationEvent, { type: "thread.activity-appended" }>,
    });
    listener({
      kind: "event",
      event: {
        ...metaUpdatedEvent(threadId, 25, "Unused"),
        type: "thread.turn-diff-completed",
        payload: {
          threadId,
          turnId: TurnId.make("turn-replay"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/replay"),
          status: "ready",
          files: [],
          transitionFiles: [],
          agentTouchedPaths: [],
          turnFiles: [],
          assistantMessageId: MessageId.make("replay-assistant"),
          completedAt: "2026-10-04T00:00:00.000Z",
        },
      } as Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
    });
    listener({ kind: "synchronized", sequence: 25 });
    const replayed = selectThreadByRef(useStore.getState(), threadRef)!;
    expect(replayed.messages.map((message) => message.text)).toEqual([
      "Prompt",
      "Answer continued",
    ]);
    expect(
      replayed.activities.filter((activity) => activity.id === "replay-activity"),
    ).toHaveLength(1);
    expect(replayed.turnDiffSummaries.filter((turn) => turn.turnId === "turn-replay")).toHaveLength(
      1,
    );
    await vi.advanceTimersByTimeAsync(32);
    const afterTimer = selectThreadByRef(useStore.getState(), threadRef)!;
    expect(afterTimer.messages.map((message) => message.text)).toEqual([
      "Prompt",
      "Answer continued",
    ]);
    expect(
      afterTimer.activities.filter((activity) => activity.id === "replay-activity"),
    ).toHaveLength(1);
    expect(
      afterTimer.turnDiffSummaries.filter((turn) => turn.turnId === "turn-replay"),
    ).toHaveLength(1);
    const subscribeInput = mockSubscribeThread.mock.calls.at(-1)?.[0];
    const nextResume = typeof subscribeInput === "function" ? subscribeInput() : subscribeInput;
    expect(nextResume).toMatchObject({ afterSequence: 25 });
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("clears message eviction accounting when a live thread has no pager page", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { selectEnvironmentState, selectThreadByRef, useStore } = await import("~/store");
    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-without-page");
    const ref = { environmentId, threadId };
    mockCreateEnvironmentConnection.mock.calls[0]?.[0].syncShellSnapshot(
      makeShellSnapshotForThreads([threadId]),
      environmentId,
    );
    retainThreadDetailSubscription(environmentId, threadId);
    const listener = mockSubscribeThread.mock.calls.at(-1)?.[1] as
      | ((item: OrchestrationThreadStreamItem) => void)
      | undefined;
    if (!listener) throw new Error("subscribeThread listener was not captured");
    const timestamp = "2026-10-04T00:00:00.000Z";
    const thread = {
      ...makeOrchestrationThread(threadId, "Unpaged thread"),
      messages: Array.from({ length: 2000 }, (_, index) => ({
        id: MessageId.make(`floor-user-${index}`),
        role: "user" as const,
        text: `Message ${index}`,
        turnId: null,
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    };
    listener({
      kind: "snapshot",
      snapshot: { snapshotSequence: 100, thread },
    });
    expect(
      selectEnvironmentState(useStore.getState(), environmentId).threadHistoryById?.[threadId],
    ).toBe(undefined);

    listener({
      kind: "event",
      event: {
        ...metaUpdatedEvent(threadId, 101, "Unused"),
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId: MessageId.make("floor-user-new"),
          role: "user",
          text: "New message",
          turnId: null,
          streaming: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    });
    expect(selectThreadByRef(useStore.getState(), ref)?.messages).toHaveLength(2000);

    const retained = selectThreadByRef(useStore.getState(), ref)!;
    const userOrigins = Object.fromEntries(
      retained.messages.map((message, index) => [
        message.id,
        { sequence: index + 1, rowId: index + 1 },
      ]),
    );
    listener({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 102,
        thread: {
          ...thread,
          messages: thread.messages.filter((message) =>
            retained.messages.some((retainedMessage) => retainedMessage.id === message.id),
          ),
        },
        page: {
          snapshotSequence: 102,
          threadSequence: 102,
          beforeCursor: null,
          hasMore: false,
          windowStart: { sequence: 1, rowId: 1 },
          userOrigins,
        },
      },
    });
    expect(
      selectEnvironmentState(useStore.getState(), environmentId).threadHistoryById?.[threadId],
    ).toMatchObject({
      beforeCursor: null,
      hasMore: false,
    });
    stop();
    await resetEnvironmentServiceForTests();
  });
});
