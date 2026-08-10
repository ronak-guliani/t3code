import { scopedThreadKey } from "@t3tools/client-runtime";
import type { OrchestrationSessionStatus, ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { create } from "zustand";

import { derivePhase } from "./session-logic";
import type { SessionPhase, Thread } from "./types";

export interface PendingTurnSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: OrchestrationSessionStatus | null;
  sessionUpdatedAt: string | null;
}

interface PendingTurnStoreState {
  pendingByThreadKey: Record<string, PendingTurnSnapshot>;
  beginPendingTurn: (
    threadRef: ScopedThreadRef,
    thread: Thread | undefined,
    options?: { preparingWorktree?: boolean },
  ) => void;
  clearPendingTurn: (threadRef: ScopedThreadRef) => void;
}

export function createPendingTurnSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): PendingTurnSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedPendingTurn(input: {
  pendingTurn: PendingTurnSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.pendingTurn) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestTurnChanged =
    input.pendingTurn.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.pendingTurn.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.pendingTurn.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.pendingTurn.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    if (!latestTurnChanged || latestTurn === null || latestTurn.startedAt === null) {
      return false;
    }
    if (
      session?.activeTurnId !== undefined &&
      session.activeTurnId !== null &&
      latestTurn.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.pendingTurn.sessionOrchestrationStatus !== (session?.orchestrationStatus ?? null) ||
    input.pendingTurn.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}

export function isPendingTurnActive(
  pendingTurn: PendingTurnSnapshot | null | undefined,
  thread:
    | Pick<Thread, "latestTurn" | "session" | "error">
    | {
        latestTurn: Thread["latestTurn"];
        session: Thread["session"];
        hasPendingApprovals: boolean;
        hasPendingUserInput: boolean;
      }
    | null
    | undefined,
): boolean {
  if (!pendingTurn) {
    return false;
  }
  if (!thread) {
    return true;
  }
  return !hasServerAcknowledgedPendingTurn({
    pendingTurn,
    phase: derivePhase(thread.session),
    latestTurn: thread.latestTurn,
    session: thread.session,
    hasPendingApproval: "hasPendingApprovals" in thread && thread.hasPendingApprovals,
    hasPendingUserInput: "hasPendingUserInput" in thread && thread.hasPendingUserInput,
    threadError: "error" in thread ? thread.error : undefined,
  });
}

export const usePendingTurnStore = create<PendingTurnStoreState>((set) => ({
  pendingByThreadKey: {},
  beginPendingTurn: (threadRef, thread, options) => {
    const threadKey = scopedThreadKey(threadRef);
    set((state) => {
      const current = state.pendingByThreadKey[threadKey];
      const preparingWorktree = Boolean(options?.preparingWorktree);
      const pendingTurn =
        current && isPendingTurnActive(current, thread)
          ? current.preparingWorktree === preparingWorktree
            ? current
            : { ...current, preparingWorktree }
          : createPendingTurnSnapshot(thread, options);
      if (pendingTurn === current) {
        return state;
      }
      return {
        pendingByThreadKey: {
          ...state.pendingByThreadKey,
          [threadKey]: pendingTurn,
        },
      };
    });
  },
  clearPendingTurn: (threadRef) => {
    const threadKey = scopedThreadKey(threadRef);
    set((state) => {
      if (!(threadKey in state.pendingByThreadKey)) {
        return state;
      }
      const { [threadKey]: _removed, ...pendingByThreadKey } = state.pendingByThreadKey;
      return { pendingByThreadKey };
    });
  },
}));
