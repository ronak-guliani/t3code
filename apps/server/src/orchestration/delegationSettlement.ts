import type {
  ChildNudgeUpdate,
  OrchestrationReadModel,
  OrchestrationThread,
  TurnId,
} from "@t3tools/contracts";

import { childWakeReason } from "./childNudging.ts";
import { threadHasPendingInteraction } from "./commandInvariants.ts";

export interface DelegationSettlement {
  readonly completedAt: string;
  readonly turnId: TurnId;
  readonly outcome: "result-available" | "failed" | "blocked";
  readonly report: ChildNudgeUpdate;
}

export function settleDelegation(
  readModel: OrchestrationReadModel,
  child: OrchestrationThread,
): DelegationSettlement | null {
  const delegation = child.nudging?.delegation;
  const latestTurn = child.latestTurn;
  if (
    !delegation ||
    delegation.completedAt !== null ||
    child.parentThreadId == null ||
    child.deletedAt !== null ||
    child.archivedAt !== null ||
    !latestTurn ||
    (latestTurn.state !== "completed" &&
      latestTurn.state !== "error" &&
      latestTurn.state !== "interrupted") ||
    child.session?.status === "running" ||
    child.session?.activeTurnId != null ||
    (child.queuedTurns?.length ?? 0) > 0 ||
    threadHasPendingInteraction(child) ||
    delegation.decision != null ||
    delegation.pendingResponse != null ||
    (delegation.dispatchId !== undefined && delegation.dispatchTurnId == null) ||
    (delegation.dispatchTurnId != null && delegation.dispatchTurnId !== latestTurn.turnId) ||
    (delegation.assignedAt !== undefined && latestTurn.requestedAt < delegation.assignedAt) ||
    readModel.threads.some(
      (descendant) =>
        descendant.parentThreadId === child.id &&
        descendant.deletedAt === null &&
        descendant.archivedAt === null &&
        descendant.nudging?.delegation?.followUp === "automatic" &&
        descendant.nudging.delegation.completedAt === null,
    )
  ) {
    return null;
  }

  const completion = child.activities.findLast(
    (activity) =>
      activity.kind === "insights.turn.completed" && activity.turnId === latestTurn.turnId,
  );
  const completionState =
    completion?.payload !== null &&
    typeof completion?.payload === "object" &&
    completion.payload !== undefined &&
    "state" in completion.payload
      ? completion.payload.state
      : undefined;
  const outcome =
    completionState === "failed" || latestTurn.state === "error"
      ? "failed"
      : completionState === "completed" && latestTurn.state === "completed"
        ? "result-available"
        : "blocked";
  const resultMessage = child.messages.findLast(
    (message) =>
      message.role === "assistant" && message.turnId === latestTurn.turnId && !message.streaming,
  );
  const reportId = delegation.dispatchId
    ? `assignment:${child.id}:${delegation.dispatchId}:${delegation.assignmentId}`
    : `assignment:${child.id}:${delegation.assignmentId}`;
  const summary =
    outcome === "result-available"
      ? `Child returned a result; task success and background completion are not verified.${resultMessage ? `\n${resultMessage.text.slice(0, 3000)}` : " No final result message was recorded."}`
      : outcome === "failed"
        ? "The delegated execution failed. Inspect the child for details."
        : "Delegated completion is unconfirmed or interrupted. Inspect the child before continuing.";

  return {
    completedAt: latestTurn.completedAt ?? completion?.createdAt ?? latestTurn.requestedAt,
    turnId: latestTurn.turnId,
    outcome,
    report: {
      id: reportId,
      assignmentId: delegation.assignmentId,
      ...(delegation.dispatchId ? { dispatchId: delegation.dispatchId } : {}),
      childThreadId: child.id,
      childTitle: child.title,
      kind: outcome,
      wakeReason: childWakeReason({ kind: outcome }),
      summary,
      ...(resultMessage ? { sourceMessageId: resultMessage.id } : {}),
    },
  };
}
