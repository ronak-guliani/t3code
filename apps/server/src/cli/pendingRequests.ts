import type { OrchestrationThread } from "@t3tools/contracts";

export function pendingActivitiesFor(input: {
  readonly thread: Pick<OrchestrationThread, "id" | "title" | "activities" | "activityContext">;
  readonly requestedKind: "approval.requested" | "user-input.requested";
  readonly resolvedKind: "approval.resolved" | "user-input.resolved";
}) {
  const activities = new Map(
    [...(input.thread.activityContext ?? []), ...input.thread.activities].map((activity) => [
      activity.id,
      activity,
    ]),
  );
  const pending = new Map<string, OrchestrationThread["activities"][number]>();
  for (const activity of [...activities.values()].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      Number(a.kind !== input.requestedKind) - Number(b.kind !== input.requestedKind) ||
      a.id.localeCompare(b.id),
  )) {
    const payload = activity.payload;
    if (typeof payload !== "object" || payload === null || !("requestId" in payload)) continue;
    if (typeof payload.requestId !== "string" || payload.requestId.length === 0) continue;
    if (activity.kind === input.requestedKind) pending.set(payload.requestId, activity);
    const failedKind =
      input.requestedKind === "approval.requested"
        ? "provider.approval.respond.failed"
        : "provider.user-input.respond.failed";
    const stale =
      activity.kind === failedKind &&
      "detail" in payload &&
      typeof payload.detail === "string" &&
      /(?:stale|unknown) pending (?:approval|permission|user-input) request/i.test(payload.detail);
    if (activity.kind === input.resolvedKind || stale) pending.delete(payload.requestId);
  }
  return [...pending].map(([requestId, activity]) => ({
    threadId: input.thread.id,
    threadTitle: input.thread.title,
    requestId,
    turnId: activity.turnId,
    summary: activity.summary,
    payload: activity.payload,
    createdAt: activity.createdAt,
  }));
}
