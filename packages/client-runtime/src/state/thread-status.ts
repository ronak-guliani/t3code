import type {
  OrchestrationBackgroundAgentRunShell,
  OrchestrationSessionStatus,
} from "@t3tools/contracts";

export type ThreadSemanticStatus =
  | "approval"
  | "input"
  | "working"
  | "connecting"
  | "failed"
  | "plan-ready"
  | "completed"
  | "ready";

type ThreadSessionStatus =
  | OrchestrationSessionStatus
  | "connecting"
  | "closed"
  | "disconnected"
  | "error"
  | "ready";

type ThreadLatestTurn = {
  readonly turnId: string;
  readonly state?: "completed" | "error" | "interrupted" | "running";
  readonly startedAt: string | null;
  readonly completedAt: string | null;
};

export interface ThreadStatusSession {
  readonly status?: ThreadSessionStatus;
  readonly orchestrationStatus?: OrchestrationSessionStatus | undefined;
  readonly activeTurnId?: string | null | undefined;
}

export interface ThreadStatusInput {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasPendingQueuedTurn?: boolean | undefined;
  readonly hasPendingTurn?: boolean | undefined;
  readonly latestTurn?: ThreadLatestTurn | null;
  readonly session?: ThreadStatusSession | null;
  readonly virtualAgentRun?:
    | Pick<OrchestrationBackgroundAgentRunShell, "status">
    | null
    | undefined;
  readonly hasPlanReady?: boolean | undefined;
  readonly hasUnseenCompletion?: boolean | undefined;
}

function sessionActivityStatus(
  session: ThreadStatusSession | null | undefined,
): ThreadSessionStatus | null {
  return session?.orchestrationStatus ?? session?.status ?? null;
}

function isTerminalSessionStatus(status: ThreadSessionStatus | null): boolean {
  return (
    status === "idle" ||
    status === "disconnected" ||
    status === "interrupted" ||
    status === "stopped" ||
    status === "error"
  );
}

export function isThreadActivelyWorking(input: {
  readonly latestTurn?: ThreadLatestTurn | null;
  readonly session?: ThreadStatusSession | null;
  readonly hasPendingQueuedTurn?: boolean | undefined;
  readonly hasPendingTurn?: boolean | undefined;
  readonly virtualAgentRun?:
    | Pick<OrchestrationBackgroundAgentRunShell, "status">
    | null
    | undefined;
}): boolean {
  if (input.hasPendingTurn || input.hasPendingQueuedTurn) return true;
  if (input.virtualAgentRun?.status === "running") return true;

  const activityStatus = sessionActivityStatus(input.session);
  if (isTerminalSessionStatus(activityStatus)) return false;

  if (input.latestTurn?.state === "running") {
    return true;
  }
  if (input.latestTurn?.startedAt != null && input.latestTurn.completedAt == null) {
    return true;
  }

  if (activityStatus !== "running" || input.session?.activeTurnId == null) {
    return false;
  }

  if (input.latestTurn == null) return true;
  if (input.latestTurn.turnId !== input.session.activeTurnId) return true;
  return input.latestTurn.completedAt === null;
}

export function isLatestTurnSettled(
  latestTurn: ThreadLatestTurn | null | undefined,
  session?: ThreadStatusSession | null,
): boolean {
  if (latestTurn == null) {
    return !(sessionActivityStatus(session) === "running" && session?.activeTurnId != null);
  }
  if (isTerminalSessionStatus(sessionActivityStatus(session))) return true;
  if (latestTurn.startedAt == null || latestTurn.completedAt == null) return false;
  if (session == null) return true;
  if (sessionActivityStatus(session) !== "running" || session.activeTurnId == null) return true;
  return session.activeTurnId === latestTurn.turnId;
}

export function hasUnseenThreadCompletion(input: {
  readonly latestTurn?: Pick<ThreadLatestTurn, "completedAt"> | null;
  readonly lastVisitedAt?: string | null | undefined;
}): boolean {
  const completedAt = input.latestTurn?.completedAt;
  if (completedAt == null || !Number.isFinite(Date.parse(completedAt))) return false;
  if (input.lastVisitedAt == null) return true;
  const visitedAt = Date.parse(input.lastVisitedAt);
  return !Number.isFinite(visitedAt) || Date.parse(completedAt) > visitedAt;
}

export function resolveThreadSemanticStatus(input: ThreadStatusInput): ThreadSemanticStatus {
  if (input.hasPendingApprovals) return "approval";
  if (input.hasPendingUserInput) return "input";
  if (isThreadActivelyWorking(input)) return "working";

  const activityStatus = sessionActivityStatus(input.session);
  if (
    activityStatus === "starting" ||
    input.session?.status === "starting" ||
    input.session?.status === "connecting"
  ) {
    return "connecting";
  }

  if (
    activityStatus === "error" ||
    input.session?.status === "error" ||
    input.latestTurn?.state === "error" ||
    input.virtualAgentRun?.status === "failed"
  ) {
    return "failed";
  }

  if (input.hasPlanReady) return "plan-ready";
  if (input.hasUnseenCompletion) return "completed";
  return "ready";
}
