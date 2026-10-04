import { EventId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildInteractionDismissalActivities,
  isInteractionSessionDead,
  unresolvedInteractionRequests,
} from "./interactionDismissal.ts";

const activity = (input: {
  readonly id: string;
  readonly kind: string;
  readonly requestId?: string;
  readonly createdAt: string;
}) => ({
  id: EventId.make(input.id),
  tone: "approval" as const,
  kind: input.kind,
  summary: input.kind,
  payload:
    input.requestId === undefined
      ? { detail: "no-request" }
      : { requestId: input.requestId, detail: "needs decision" },
  turnId: null,
  createdAt: input.createdAt,
});

describe("interactionDismissal", () => {
  it("pairs requested and resolved activities by requestId", () => {
    const thread = {
      activities: [
        activity({
          id: "a1",
          kind: "approval.requested",
          requestId: "req-1",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
        activity({
          id: "a2",
          kind: "approval.requested",
          requestId: "req-2",
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
        activity({
          id: "a3",
          kind: "approval.resolved",
          requestId: "req-1",
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
        activity({
          id: "a4",
          kind: "user-input.requested",
          requestId: "q-1",
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      ],
    };

    expect(unresolvedInteractionRequests(thread)).toEqual([
      { kind: "approval", requestId: "req-2", turnId: null },
      { kind: "user-input", requestId: "q-1", turnId: null },
    ]);
  });

  it("ignores activities without requestIds and resolves out-of-order pairs", () => {
    const thread = {
      activities: [
        activity({ id: "b1", kind: "approval.requested", createdAt: "2026-01-01T00:00:01.000Z" }),
        activity({
          id: "b2",
          kind: "approval.resolved",
          requestId: "req-9",
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
        activity({
          id: "b3",
          kind: "approval.requested",
          requestId: "req-9",
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
      ],
    };

    // Creation order decides: the resolve precedes the request, so req-9 stays pending.
    expect(unresolvedInteractionRequests(thread)).toEqual([
      { kind: "approval", requestId: "req-9", turnId: null },
    ]);
  });

  it("builds dismissed resolution activities carrying the reason", () => {
    const thread = {
      activities: [
        activity({
          id: "c1",
          kind: "approval.requested",
          requestId: "req-1",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
        activity({
          id: "c2",
          kind: "user-input.requested",
          requestId: "q-1",
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
      ],
    };

    const dismissed = buildInteractionDismissalActivities({
      thread,
      reason: "The provider turn ended before this request was answered.",
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    expect(dismissed).toHaveLength(2);
    expect(dismissed[0]).toMatchObject({
      tone: "approval",
      kind: "approval.resolved",
      summary: "Approval dismissed",
      payload: {
        requestId: "req-1",
        dismissed: true,
        reason: "The provider turn ended before this request was answered.",
      },
    });
    expect(dismissed[1]).toMatchObject({
      tone: "info",
      kind: "user-input.resolved",
      summary: "User input dismissed",
      payload: { requestId: "q-1", dismissed: true },
    });
    for (const entry of dismissed) {
      expect(entry.createdAt).toBe("2026-01-01T00:01:00.000Z");
    }
  });

  it("builds no activities when nothing is unresolved", () => {
    const thread = { activities: [] as ReturnType<typeof activity>[] };
    expect(
      buildInteractionDismissalActivities({
        thread,
        reason: "r",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("treats missing, stopped, errored, and interrupted sessions as dead", () => {
    expect(isInteractionSessionDead(null)).toBe(true);
    expect(isInteractionSessionDead(undefined)).toBe(true);
    for (const status of ["stopped", "error", "interrupted"] as const) {
      expect(isInteractionSessionDead({ status })).toBe(true);
    }
    for (const status of ["idle", "starting", "running", "ready"] as const) {
      expect(isInteractionSessionDead({ status })).toBe(false);
    }
  });
});
