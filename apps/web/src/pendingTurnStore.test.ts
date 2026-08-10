import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { isPendingTurnActive, usePendingTurnStore } from "./pendingTurnStore";

const threadRef = scopeThreadRef(
  EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
  ThreadId.make("thread-1"),
);

describe("pendingTurnStore", () => {
  beforeEach(() => {
    usePendingTurnStore.setState({ pendingByThreadKey: {} });
  });

  it("keeps pending feedback available across component remounts", () => {
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);

    const pendingTurn = Object.values(usePendingTurnStore.getState().pendingByThreadKey)[0];
    expect(isPendingTurnActive(pendingTurn, null)).toBe(true);
  });

  it("clears pending feedback explicitly after acknowledgement or failure", () => {
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);
    usePendingTurnStore.getState().clearPendingTurn(threadRef);

    expect(usePendingTurnStore.getState().pendingByThreadKey).toEqual({});
  });

  it("replaces an acknowledged snapshot when a later send starts", () => {
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);
    const first = Object.values(usePendingTurnStore.getState().pendingByThreadKey)[0]!;

    usePendingTurnStore.getState().beginPendingTurn(threadRef, {
      id: threadRef.threadId,
      environmentId: threadRef.environmentId,
      codexThreadId: null,
      projectId: ProjectId.make("project-1"),
      parentThreadId: null,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("copilot"), model: "gpt-5" },
      runtimeMode: "full-access",
      pendingRuntimeMode: null,
      interactionMode: "default",
      session: {
        provider: ProviderDriverKind.make("copilot"),
        status: "ready",
        createdAt: first.startedAt,
        updatedAt: "2026-01-01T00:00:01.000Z",
        orchestrationStatus: "idle",
      },
      messages: [],
      proposedPlans: [],
      queuedTurns: [],
      error: null,
      createdAt: first.startedAt,
      archivedAt: null,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: first.startedAt,
        startedAt: first.startedAt,
        completedAt: "2026-01-01T00:00:01.000Z",
        assistantMessageId: null,
      },
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    const second = Object.values(usePendingTurnStore.getState().pendingByThreadKey)[0]!;
    expect(second).not.toBe(first);
  });
});
