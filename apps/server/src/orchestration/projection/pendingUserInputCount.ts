import { ApprovalRequestId } from "@t3tools/contracts";

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}

function staleUserInputFailure(detail: string | null): boolean {
  return (
    detail !== null &&
    (detail.includes("stale pending user-input request") ||
      detail.includes("unknown pending user-input request"))
  );
}

export function derivePendingUserInputCount(
  activities: ReadonlyArray<{
    readonly activityId: string;
    readonly kind: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }>,
): number {
  const openRequestIds = new Set<string>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );

  for (const activity of ordered) {
    const requestId = extractActivityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;

    if (activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      activity.kind === "provider.user-input.respond.failed" &&
      staleUserInputFailure(detail)
    ) {
      openRequestIds.delete(requestId);
    }
  }

  return openRequestIds.size;
}
