/**
 * Dismissal of orphaned approval and user-input requests.
 *
 * `approval.requested` / `user-input.requested` activities resolve only when
 * the provider answers through its live callback. When the owning provider
 * turn dies first (interrupt, session stop, server restart), the request can
 * never be answered, but the unresolved activity keeps blocking queued-turn
 * dispatch (`threadHasPendingInteraction`) and delegation settlement
 * forever. Dismissal appends the matching `*.resolved` activity with
 * `dismissed: true` so the existing requestId pairing treats the request as
 * settled without pretending the user answered it.
 *
 * @module interactionDismissal
 */
import {
  EventId,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@t3tools/contracts";

export interface UnresolvedInteractionRequest {
  readonly kind: "approval" | "user-input";
  readonly requestId: string;
  readonly turnId: TurnId | null;
}

type InteractionActivities = Pick<
  { readonly activities: ReadonlyArray<OrchestrationThreadActivity> },
  "activities"
>;

function requestIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
}

/**
 * Mirrors the requested/resolved pairing in `threadHasPendingInteraction`:
 * activities ordered by creation time, requested ids added, resolved ids
 * removed. Only requests this function reports keep the thread blocked, so
 * only they need dismissal.
 */
export function unresolvedInteractionRequests(
  thread: Pick<InteractionActivities, "activities">,
): UnresolvedInteractionRequest[] {
  const pending = new Map<string, UnresolvedInteractionRequest>();
  const ordered = thread.activities
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const activity of ordered) {
    const requestId = requestIdOf(activity.payload);
    if (requestId === null) {
      continue;
    }
    if (activity.kind === "approval.requested") {
      pending.set(requestId, { kind: "approval", requestId, turnId: activity.turnId });
    } else if (activity.kind === "user-input.requested") {
      pending.set(requestId, { kind: "user-input", requestId, turnId: activity.turnId });
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      pending.delete(requestId);
    }
  }
  return [...pending.values()];
}

/**
 * Sessions that can no longer answer provider callbacks. A stopped, errored,
 * or interrupted session lost its provider turn; a missing session never had
 * one. Live states (idle/starting/running/ready) may still answer.
 */
export function isInteractionSessionDead(
  session: Pick<OrchestrationSession, "status"> | null | undefined,
): boolean {
  return (
    session == null ||
    session.status === "stopped" ||
    session.status === "error" ||
    session.status === "interrupted"
  );
}

export function buildInteractionDismissalActivities(input: {
  readonly thread: Pick<InteractionActivities, "activities">;
  readonly reason: string;
  readonly createdAt: string;
}): OrchestrationThreadActivity[] {
  return unresolvedInteractionRequests(input.thread).map((request) => ({
    id: EventId.make(crypto.randomUUID()),
    tone: request.kind === "approval" ? ("approval" as const) : ("info" as const),
    kind: request.kind === "approval" ? "approval.resolved" : "user-input.resolved",
    summary: request.kind === "approval" ? "Approval dismissed" : "User input dismissed",
    payload: {
      requestId: request.requestId,
      dismissed: true,
      reason: input.reason,
    },
    turnId: request.turnId,
    createdAt: input.createdAt,
  }));
}
