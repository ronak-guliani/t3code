import type { OrchestrationLatestTurn, OrchestrationThreadActivity } from "@t3tools/contracts";

const TURN_COMPLETED_ACTIVITY_KIND = "insights.turn.completed";

type TriState = "yes" | "no" | "unknown";

interface TurnCompletionEvidence {
  readonly stopReason: string | null;
  readonly assistantTextObserved: TriState;
  readonly assistantMessagePersisted: TriState;
  readonly activityId: string;
  readonly observedAt: string;
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function triState(value: unknown): TriState {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

// Activity pages are newest-first, so the first matching completion is the
// latest one the page holds.
function newestTurnCompletion(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: string | null,
): OrchestrationThreadActivity | null {
  for (const activity of activities) {
    if (activity.kind !== TURN_COMPLETED_ACTIVITY_KIND) continue;
    if (turnId !== null && activity.turnId !== turnId) continue;
    return activity;
  }
  return null;
}

function readTurnCompletionEvidence(
  activity: OrchestrationThreadActivity | null,
): TurnCompletionEvidence | null {
  if (activity === null) return null;
  const payload = payloadRecord(activity.payload);
  if (payload === null) return null;
  const stopReason = payload.stopReason;
  return {
    stopReason: typeof stopReason === "string" && stopReason.trim().length > 0 ? stopReason : null,
    assistantTextObserved: triState(payload.assistantTextObserved),
    assistantMessagePersisted: triState(payload.assistantMessagePersisted),
    activityId: String(activity.id),
    observedAt: activity.createdAt,
  };
}

function deliveryVerdict(evidence: TurnCompletionEvidence | null): string {
  if (evidence === null) return "unknown";
  // A turn that only ran tools never produced assistant text, so a missing reply
  // is the expected outcome rather than a delivery failure.
  if (evidence.assistantTextObserved === "no") return "not expected";
  if (evidence.assistantTextObserved === "unknown") return "unknown";
  return evidence.assistantMessagePersisted === "no" ? "incomplete" : "complete";
}

/**
 * Deterministic correlation of already-persisted turn evidence. No inference
 * beyond what the activity feed recorded.
 */
export function explainTurn(input: {
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): ReadonlyArray<string> {
  const turnId = input.latestTurn === null ? null : String(input.latestTurn.turnId);
  const evidence = readTurnCompletionEvidence(newestTurnCompletion(input.activities, turnId));

  const lines: Array<string> = [
    input.latestTurn === null
      ? "Turn: none recorded"
      : `Turn: ${input.latestTurn.state} (turn ${turnId})`,
  ];

  if (evidence === null) {
    lines.push(
      "Provider completion: unknown",
      "Provider assistant text: unknown",
      "Persisted assistant message: unknown",
      "Reply delivery: unknown",
      `No ${TURN_COMPLETED_ACTIVITY_KIND} activity for this turn is in the page; re-run with --limit or an older --before cursor.`,
    );
    return lines;
  }

  // An absent stop reason is a provider capability gap (Pi never sets it), not a
  // failed turn, so it must not be rendered as a failure.
  lines.push(
    `Provider completion: ${evidence.stopReason ?? "not reported by this provider"}`,
    `Provider assistant text: ${observedLabel(evidence.assistantTextObserved)}`,
    `Persisted assistant message: ${persistedLabel(evidence.assistantMessagePersisted)}`,
    `Reply delivery: ${deliveryVerdict(evidence)}`,
    `Evidence: ${TURN_COMPLETED_ACTIVITY_KIND} ${evidence.activityId} at ${evidence.observedAt}`,
  );
  return lines;
}

function observedLabel(state: TriState): string {
  switch (state) {
    case "yes":
      return "observed";
    case "no":
      return "not observed";
    case "unknown":
      return "unknown";
  }
}

function persistedLabel(state: TriState): string {
  switch (state) {
    case "yes":
      return "present";
    case "no":
      return "absent";
    case "unknown":
      return "unknown";
  }
}
