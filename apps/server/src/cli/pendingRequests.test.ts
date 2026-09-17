import { EventId, ThreadId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { pendingActivitiesFor } from "./pendingRequests.ts";

describe.each(["approval", "user-input"] as const)("pending %s requests", (kind) => {
  const activity = (id: string, event: string, detail?: string): OrchestrationThreadActivity => ({
    id: EventId.make(id),
    kind: event,
    tone: "info",
    summary: "Request",
    turnId: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    payload: { requestId: "request", ...(detail ? { detail } : {}) },
  });
  const requested = activity("request", `${kind}.requested`);
  const list = (activities: OrchestrationThreadActivity[], activityContext = [requested]) =>
    pendingActivitiesFor({
      thread: { id: ThreadId.make("thread"), title: "Thread", activities, activityContext },
      requestedKind: `${kind}.requested`,
      resolvedKind: `${kind}.resolved`,
    });
  it("retains out-of-window pending requests and deduplicates overlap", () => {
    expect(list([])).toHaveLength(1);
    expect(list([requested])).toHaveLength(1);
  });
  it("lets resolution win even at the same timestamp", () => {
    expect(list([activity("a", `${kind}.resolved`), requested])).toEqual([]);
  });
  it("dismisses stale requests but preserves retryable response failures", () => {
    expect(
      list([
        activity("failure", `provider.${kind}.respond.failed`, `Unknown pending ${kind} request`),
      ]),
    ).toEqual([]);
    expect(
      list([activity("failure", `provider.${kind}.respond.failed`, "Network unavailable")]),
    ).toHaveLength(1);
  });
});
