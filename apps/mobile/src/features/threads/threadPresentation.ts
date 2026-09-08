import type { StatusTone } from "../../components/StatusPill";
import {
  hasUnseenThreadCompletion,
  isLatestTurnSettled,
  resolveThreadSemanticStatus,
} from "@t3tools/client-runtime/state/thread-status";
import type { MobileThreadShell } from "./mobile-thread-hierarchy";

export type ThreadStatusKind =
  | "pending-approval"
  | "awaiting-input"
  | "working"
  | "connecting"
  | "error"
  | "plan-ready"
  | "completed";

export interface ThreadStatusPresentation extends StatusTone {
  readonly kind: ThreadStatusKind;
  /** Foreground color for the leading status icon. */
  readonly iconColor: string;
  /** Background color for the leading status icon circle. */
  readonly iconBackground: string;
  /** Whether the indicator represents in-flight activity. */
  readonly pulse: boolean;
}

/**
 * Resolves the user-facing status of a thread, in priority order. Returns
 * `null` for quiescent threads so rows stay free of "Idle"-style noise.
 * Mirrors `resolveThreadStatusPill` in apps/web/src/components/Sidebar.logic.ts.
 */
export function resolveThreadStatus(
  thread: MobileThreadShell,
  lastVisitedAt?: string | null,
): ThreadStatusPresentation | null {
  const hasPlanReady =
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  const semanticStatus = resolveThreadSemanticStatus({
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasPendingQueuedTurn: thread.hasPendingQueuedTurn,
    latestTurn: thread.latestTurn,
    session: thread.session,
    virtualAgentRun: thread.virtualAgentRun,
    hasPlanReady,
    hasUnseenCompletion: hasUnseenThreadCompletion({
      latestTurn: thread.latestTurn,
      lastVisitedAt,
    }),
  });

  if (semanticStatus === "approval") {
    return {
      kind: "pending-approval",
      label: "Needs Approval",
      pillClassName: "bg-adaptive-amber-500-a12-a16",
      textClassName: "text-adaptive-amber-700-300",
      iconColor: "#ff9f0a",
      iconBackground: "rgba(255,159,10,0.22)",
      pulse: false,
    };
  }

  if (semanticStatus === "input") {
    return {
      kind: "awaiting-input",
      label: "Awaiting Input",
      pillClassName: "bg-adaptive-indigo-500-a12-a16",
      textClassName: "text-adaptive-indigo-700-300",
      iconColor: "#5e5ce6",
      iconBackground: "rgba(94,92,230,0.22)",
      pulse: false,
    };
  }

  if (semanticStatus === "working") {
    return {
      kind: "working",
      label: "Working",
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-700-300",
      iconColor: "#0a84ff",
      iconBackground: "rgba(10,132,255,0.22)",
      pulse: true,
    };
  }

  if (semanticStatus === "connecting") {
    return {
      kind: "connecting",
      label: "Connecting",
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-700-300",
      iconColor: "#0a84ff",
      iconBackground: "rgba(10,132,255,0.22)",
      pulse: true,
    };
  }

  if (semanticStatus === "failed") {
    return {
      kind: "error",
      label: "Error",
      pillClassName: "bg-adaptive-rose-500-a12-a16",
      textClassName: "text-adaptive-rose-700-300",
      iconColor: "#ff453a",
      iconBackground: "rgba(255,69,58,0.22)",
      pulse: false,
    };
  }

  if (semanticStatus === "plan-ready") {
    return {
      kind: "plan-ready",
      label: "Plan Ready",
      pillClassName: "bg-adaptive-violet-500-a12-a16",
      textClassName: "text-adaptive-violet-700-300",
      iconColor: "#bf5af2",
      iconBackground: "rgba(191,90,242,0.22)",
      pulse: false,
    };
  }

  if (semanticStatus === "completed") {
    return {
      kind: "completed",
      label: "Done",
      pillClassName: "bg-adaptive-emerald-500-a12-a16",
      textClassName: "text-adaptive-emerald-700-300",
      iconColor: "#30d158",
      iconBackground: "rgba(48,209,88,0.22)",
      pulse: false,
    };
  }

  return null;
}
