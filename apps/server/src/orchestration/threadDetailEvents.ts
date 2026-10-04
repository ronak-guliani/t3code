import type { OrchestrationEvent } from "@t3tools/contracts";

// Paged snapshot watermarks must only name events their subscription delivers.
export const THREAD_DETAIL_EVENT_TYPES = [
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.review-result-set",
  "thread.validation-requested",
  "thread.validation-request-failed",
  "thread.validation-run-planned",
  "thread.validation-lifecycle-updated",
  "thread.validation-lease-claimed",
  "thread.validation-lease-released",
  "thread.validation-result-recorded",
  "thread.validation-gate-updated",
  "thread.proposed-plan-upserted",
  "thread.activity-appended",
  "thread.child-lifecycle-notified",
  "thread.cross-thread-send-recorded",
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.session-set",
  "thread.queued-turn-created",
  "thread.queued-turn-updated",
  "thread.queued-turn-deleted",
  "thread.queued-turn-dispatched",
  "thread.queued-turn-failed",
  "thread.queued-turn-reordered",
  "thread.queue-held",
  "thread.queue-released",
] as const satisfies readonly OrchestrationEvent["type"][];
const detailEventTypes = new Set<string>(THREAD_DETAIL_EVENT_TYPES);

export function isThreadDetailEvent(
  event: OrchestrationEvent,
): event is Extract<OrchestrationEvent, { type: (typeof THREAD_DETAIL_EVENT_TYPES)[number] }> {
  return detailEventTypes.has(event.type);
}
