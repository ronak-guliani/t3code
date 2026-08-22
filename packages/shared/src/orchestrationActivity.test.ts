import { EventId, ThreadId, type ChildThreadLifecycleNotification } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  childLifecycleNotificationToActivity,
  isChildLifecycleThreadActivity,
} from "./orchestrationActivity.ts";

const basePayload = {
  parentThreadId: ThreadId.make("parent-thread"),
  childThreadId: ThreadId.make("child-thread"),
  childTitle: "Release assistant",
  dedupeKey: "child:child-thread:lifecycle:source",
  createdAt: "2026-08-21T00:00:00.000Z",
} as const;

const cases: ReadonlyArray<{
  readonly payload: ChildThreadLifecycleNotification;
  readonly summary: string;
  readonly tone: "info" | "approval" | "error";
}> = [
  {
    payload: { ...basePayload, lifecycle: "started" },
    summary: "Release assistant started",
    tone: "info",
  },
  {
    payload: { ...basePayload, lifecycle: "blocked" },
    summary: "Release assistant is blocked",
    tone: "error",
  },
  {
    payload: { ...basePayload, lifecycle: "approval-required" },
    summary: "Release assistant needs approval",
    tone: "approval",
  },
  {
    payload: { ...basePayload, lifecycle: "input-required" },
    summary: "Release assistant needs input",
    tone: "approval",
  },
  {
    payload: { ...basePayload, lifecycle: "failed" },
    summary: "Release assistant failed",
    tone: "error",
  },
  {
    payload: { ...basePayload, lifecycle: "completed" },
    summary: "Release assistant completed",
    tone: "info",
  },
  {
    payload: {
      ...basePayload,
      lifecycle: "pr-created",
      externalAction: { url: "https://github.com/acme/app/pull/42" },
    },
    summary: "Release assistant created a pull request",
    tone: "info",
  },
];

describe("childLifecycleNotificationToActivity", () => {
  it.each(cases)("projects $payload.lifecycle lifecycle facts", ({ payload, summary, tone }) => {
    const activity = childLifecycleNotificationToActivity({
      eventId: EventId.make(`event-${payload.lifecycle}`),
      payload,
      sequence: 42,
    });

    expect(activity).toMatchObject({
      id: `event-${payload.lifecycle}`,
      kind: `child.lifecycle.${payload.lifecycle}`,
      summary,
      tone,
      payload,
      turnId: null,
      sequence: 42,
      createdAt: payload.createdAt,
    });
    expect(isChildLifecycleThreadActivity(activity)).toBe(true);
    expect(
      isChildLifecycleThreadActivity({
        ...activity,
        kind: "child.lifecycle.completed",
      }),
    ).toBe(payload.lifecycle === "completed");
  });
});
