import type {
  ChildNudgeUpdate,
  ChildWaitCondition,
  OrchestrationQueuedTurn,
  ThreadId,
  ThreadNudging,
} from "@t3tools/contracts";

export const CHILD_RESULT_COLLECTION_MS = 2_000;

export interface ChildFollowUpThread {
  readonly id: ThreadId;
  readonly parentThreadId?: ThreadId | null | undefined;
  readonly nudging?: ThreadNudging | undefined;
  readonly archivedAt: string | null;
  readonly deletedAt?: string | null | undefined;
}

export function childReportNeedsAttention(report: ChildNudgeUpdate): boolean {
  return report.kind === "decision-needed" || report.kind === "failed" || report.kind === "blocked";
}

export function childWaitIsSatisfied(wait: ChildWaitCondition): boolean {
  if (wait.mode === "decisions-only" || wait.assignments.length === 0) return false;
  const returned = (assignment: ChildWaitCondition["assignments"][number]) =>
    assignment.outcome === "result-available";
  return wait.mode === "all" ? wait.assignments.every(returned) : wait.assignments.some(returned);
}

export function childWaitBlockReason(
  wait: ChildWaitCondition | null | undefined,
  children: ReadonlyMap<ThreadId, ChildFollowUpThread>,
  parentId?: ThreadId,
): string | null {
  if (!wait || wait.satisfiedAt || childWaitIsSatisfied(wait)) return null;
  if (wait.mode === "decisions-only") return "Only decisions and blockers wake this thread.";
  for (const assignment of wait.assignments) {
    if (assignment.outcome === "result-available") continue;
    const child = children.get(assignment.childThreadId);
    if (
      !child ||
      child.archivedAt !== null ||
      child.deletedAt != null ||
      (parentId !== undefined && child.parentThreadId !== parentId) ||
      child.nudging?.delegation?.assignmentId !== assignment.assignmentId
    ) {
      return "A required assignment is unavailable. Change the wait condition.";
    }
    if (assignment.outcome)
      return "A required assignment needs attention. Change the wait condition.";
  }
  const remaining = wait.assignments.filter((entry) => entry.outcome !== "result-available").length;
  return `Waiting for ${wait.mode === "any" ? "any of " : ""}${remaining} ${remaining === 1 ? "child" : "children"}.`;
}

export function evaluateChildFollowUp(
  parent: ChildFollowUpThread,
  turn: OrchestrationQueuedTurn,
  children: ReadonlyMap<ThreadId, ChildFollowUpThread>,
  now: string,
): { updates: ReadonlyArray<ChildNudgeUpdate>; reason: string | null; dueAt: string | null } {
  if (turn.origin?.kind !== "child-nudge") return { updates: [], reason: null, dueAt: null };
  const updates = turn.origin.updates.filter((report) => {
    const child = children.get(report.childThreadId);
    if (child && child.parentThreadId !== undefined && child.parentThreadId !== parent.id)
      return false;
    if (child?.nudging?.delegation && child.nudging.delegation.assignmentId !== report.assignmentId)
      return false;
    if (report.kind !== "decision-needed") return true;
    // Legacy reports did not persist decision state; do not silently discard them.
    const decision = child?.nudging?.delegation?.decision;
    return decision === undefined || decision?.id === report.id;
  });
  if (updates.length === 0) return { updates, reason: null, dueAt: null };
  if (parent.nudging?.paused)
    return { updates, reason: "Automatic follow-up is paused.", dueAt: null };
  if (parent.archivedAt !== null || parent.deletedAt != null) {
    return { updates, reason: "The parent is archived or deleted.", dueAt: null };
  }
  if (updates.some(childReportNeedsAttention)) return { updates, reason: null, dueAt: null };
  const reason = childWaitBlockReason(parent.nudging?.wait, children, parent.id);
  if (reason) return { updates, reason, dueAt: null };
  const dueAt = turn.origin.collectUntil ?? null;
  return {
    updates,
    reason: dueAt && dueAt > now ? "Collecting child results." : null,
    dueAt: dueAt && dueAt > now ? dueAt : null,
  };
}
