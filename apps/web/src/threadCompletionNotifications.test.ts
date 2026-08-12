import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import type { EnvironmentState } from "./store";
import {
  collectStaleActiveTurnToastRequests,
  collectThreadCompletionNotifications,
} from "./threadCompletionNotifications";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const provider = ProviderDriverKind.make("copilot");
const providerInstanceId = ProviderInstanceId.make("copilot");

function makeEnvironmentState(overrides: {
  readonly bootstrapComplete: boolean;
  readonly turnId?: TurnId;
  readonly threadId?: ThreadId;
  readonly title?: string;
  readonly completedAt?: string;
  readonly activeTurnId?: TurnId | null;
  readonly turnState?: "completed" | "interrupted" | "error" | "running";
  readonly sessionStatus?: "running" | "ready" | "idle" | "interrupted" | "stopped" | "error";
  readonly hasPendingQueuedTurn?: boolean;
}): EnvironmentState {
  const nextThreadId = overrides.threadId ?? threadId;
  const turnId = overrides.turnId ?? TurnId.make("turn-1");
  const sessionStatus = overrides.sessionStatus;
  const legacySessionStatus =
    sessionStatus === "error"
      ? ("error" as const)
      : sessionStatus === "running"
        ? ("running" as const)
        : sessionStatus === "stopped" || sessionStatus === "idle"
          ? ("closed" as const)
          : ("ready" as const);
  const session =
    overrides.activeTurnId !== undefined || sessionStatus !== undefined
      ? {
          provider,
          providerInstanceId,
          // Legacy UI status collapses interrupted→ready; notifications must
          // key off orchestrationStatus instead.
          status: legacySessionStatus,
          orchestrationStatus: sessionStatus ?? ("running" as const),
          ...(overrides.activeTurnId != null ? { activeTurnId: overrides.activeTurnId } : {}),
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:01:00.000Z",
        }
      : null;
  return {
    projectIds: [projectId],
    projectById: {},
    threadIds: [nextThreadId],
    threadIdsByProjectId: {
      [projectId]: [nextThreadId],
    },
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    activityContextByThreadId: {},
    insightActivitiesByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    queuedTurnsByThreadId: {},
    sidebarThreadSummaryById: {
      [nextThreadId]: {
        id: nextThreadId,
        environmentId,
        projectId,
        parentThreadId: null,
        title: overrides.title ?? "Existing completed thread",
        interactionMode: "default",
        session,
        createdAt: "2026-06-10T00:00:00.000Z",
        archivedAt: null,
        updatedAt: "2026-06-10T00:01:00.000Z",
        latestTurn: {
          turnId,
          state: overrides.turnState ?? "completed",
          requestedAt: "2026-06-10T00:00:00.000Z",
          startedAt: "2026-06-10T00:00:01.000Z",
          completedAt: overrides.completedAt ?? "2026-06-10T00:01:00.000Z",
          assistantMessageId: MessageId.make("assistant-message-1"),
        },
        branch: null,
        worktreePath: null,
        latestUserMessageAt: "2026-06-10T00:00:00.000Z",
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        hasPendingQueuedTurn: overrides.hasPendingQueuedTurn ?? false,
      },
    },
    bootstrapComplete: overrides.bootstrapComplete,
  };
}

function makeTracker() {
  return {
    notifiedTurnKeys: new Set<string>(),
    bootstrappedEnvironmentIds: new Set<string>(),
  };
}

describe("collectThreadCompletionNotifications", () => {
  it("does not notify completed turns from the first bootstrapped snapshot after app restart", () => {
    const tracker = makeTracker();

    expect(
      collectThreadCompletionNotifications({
        environmentStateById: {},
        notificationMode: "background-only",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
      }),
    ).toEqual([]);

    expect(
      collectThreadCompletionNotifications({
        environmentStateById: {
          [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
        },
        notificationMode: "background-only",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
      }),
    ).toEqual([]);
  });

  it("notifies new completed turns after the environment bootstrap boundary", () => {
    const tracker = makeTracker();
    collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
      },
      notificationMode: "background-only",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    const requests = collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({
          bootstrapComplete: true,
          threadId: ThreadId.make("thread-2"),
          turnId: TurnId.make("turn-2"),
          title: "Newly completed thread",
          completedAt: "2026-06-10T00:02:00.000Z",
        }),
      },
      notificationMode: "background-only",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    expect(requests).toMatchObject([
      {
        kind: "thread-turn-completed",
        threadId: "thread-2",
        turnId: "turn-2",
        title: "Chat completed",
        body: "Newly completed thread",
        status: "completed",
      },
    ]);
  });

  it("seeds while notifications are off so enabling them does not notify historical turns", () => {
    const tracker = makeTracker();
    collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
      },
      notificationMode: "off",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    expect(
      collectThreadCompletionNotifications({
        environmentStateById: {
          [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
        },
        notificationMode: "all",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
      }),
    ).toEqual([]);
  });

  it("does not notify a completed turn while a handoff/user continuation is still queued", () => {
    const tracker = makeTracker();
    collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
      },
      notificationMode: "all",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    const completedWithQueue = makeEnvironmentState({
      bootstrapComplete: true,
      threadId: ThreadId.make("thread-handoff"),
      turnId: TurnId.make("turn-handoff-boundary"),
      title: "Handoff in progress",
      completedAt: "2026-06-10T00:03:00.000Z",
      hasPendingQueuedTurn: true,
    });

    expect(
      collectThreadCompletionNotifications({
        environmentStateById: {
          [environmentId]: completedWithQueue,
        },
        notificationMode: "all",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
      }),
    ).toEqual([]);

    // Once the queue drains, the same completed boundary may notify if it is
    // still the latest terminal turn and has not been seeded yet.
    const afterQueueDrained = makeEnvironmentState({
      bootstrapComplete: true,
      threadId: ThreadId.make("thread-handoff"),
      turnId: TurnId.make("turn-handoff-boundary"),
      title: "Handoff in progress",
      completedAt: "2026-06-10T00:03:00.000Z",
    });

    expect(
      collectThreadCompletionNotifications({
        environmentStateById: {
          [environmentId]: afterQueueDrained,
        },
        notificationMode: "all",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
      }),
    ).toMatchObject([
      {
        kind: "thread-turn-completed",
        threadId: "thread-handoff",
        turnId: "turn-handoff-boundary",
        title: "Chat completed",
      },
    ]);
  });

  it("treats an interrupted turn with a ready session as a completed chat", () => {
    const tracker = makeTracker();
    collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
      },
      notificationMode: "all",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    const requests = collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({
          bootstrapComplete: true,
          threadId: ThreadId.make("thread-ready-interrupt"),
          turnId: TurnId.make("turn-ready-interrupt"),
          title: "Finished successfully",
          completedAt: "2026-06-10T00:04:00.000Z",
          turnState: "interrupted",
          sessionStatus: "ready",
        }),
      },
      notificationMode: "all",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    expect(requests).toMatchObject([
      {
        kind: "thread-turn-completed",
        threadId: "thread-ready-interrupt",
        turnId: "turn-ready-interrupt",
        title: "Chat completed",
        status: "completed",
      },
    ]);
  });

  it("still notifies a true interrupt when the session is interrupted", () => {
    const tracker = makeTracker();
    collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
      },
      notificationMode: "all",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    const requests = collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({
          bootstrapComplete: true,
          threadId: ThreadId.make("thread-true-interrupt"),
          turnId: TurnId.make("turn-true-interrupt"),
          title: "Stopped mid-turn",
          completedAt: "2026-06-10T00:05:00.000Z",
          turnState: "interrupted",
          sessionStatus: "interrupted",
        }),
      },
      notificationMode: "all",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    expect(requests).toMatchObject([
      {
        kind: "thread-turn-completed",
        threadId: "thread-true-interrupt",
        turnId: "turn-true-interrupt",
        title: "Chat interrupted",
        status: "interrupted",
      },
    ]);
  });
});

describe("collectStaleActiveTurnToastRequests", () => {
  it("warns when a completed latest turn is still marked active", () => {
    const notifiedTurnKeys = new Set<string>();
    const turnId = TurnId.make("turn-stale-active");

    const requests = collectStaleActiveTurnToastRequests({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({
          bootstrapComplete: true,
          activeTurnId: turnId,
          turnId,
          title: "Completed but still active",
        }),
      },
      notifiedTurnKeys,
    });

    expect(requests).toEqual([
      {
        environmentId,
        threadId,
        turnId,
        title: "Chat still looked active after completion",
        threadTitle: "Completed but still active",
      },
    ]);
  });

  it("does not warn twice for the same stale active turn", () => {
    const notifiedTurnKeys = new Set<string>();
    const turnId = TurnId.make("turn-stale-active");
    const environmentStateById = {
      [environmentId]: makeEnvironmentState({
        bootstrapComplete: true,
        activeTurnId: turnId,
        turnId,
      }),
    };

    collectStaleActiveTurnToastRequests({ environmentStateById, notifiedTurnKeys });

    expect(collectStaleActiveTurnToastRequests({ environmentStateById, notifiedTurnKeys })).toEqual(
      [],
    );
  });

  it("does not warn during bootstrap or for a different active turn", () => {
    const turnId = TurnId.make("turn-completed");

    expect(
      collectStaleActiveTurnToastRequests({
        environmentStateById: {
          [environmentId]: makeEnvironmentState({
            bootstrapComplete: false,
            activeTurnId: turnId,
            turnId,
          }),
        },
        notifiedTurnKeys: new Set<string>(),
      }),
    ).toEqual([]);

    expect(
      collectStaleActiveTurnToastRequests({
        environmentStateById: {
          [environmentId]: makeEnvironmentState({
            bootstrapComplete: true,
            activeTurnId: TurnId.make("turn-in-flight"),
            turnId,
          }),
        },
        notifiedTurnKeys: new Set<string>(),
      }),
    ).toEqual([]);
  });
});
