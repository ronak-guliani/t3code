import {
  ChildThreadLifecycleNotification,
  type ChildThreadLifecycle,
  type EventId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { Schema } from "effect";

const TURN_LIFECYCLE_INSIGHT_KINDS: ReadonlySet<string> = new Set([
  "insights.turn.started",
  "insights.turn.completed",
  "insights.turn.aborted",
]);

const CHILD_LIFECYCLE_ACTIVITY_PRESENTATION = {
  started: { summarySuffix: "started", tone: "info" },
  blocked: { summarySuffix: "is blocked", tone: "error" },
  "approval-required": { summarySuffix: "needs approval", tone: "approval" },
  "input-required": { summarySuffix: "needs input", tone: "approval" },
  failed: { summarySuffix: "failed", tone: "error" },
  completed: { summarySuffix: "completed", tone: "info" },
  "pr-created": { summarySuffix: "created a pull request", tone: "info" },
} as const satisfies Record<
  ChildThreadLifecycle,
  {
    readonly summarySuffix: string;
    readonly tone: "info" | "approval" | "error";
  }
>;

export type ChildLifecycleThreadActivity = Omit<OrchestrationThreadActivity, "kind" | "payload"> & {
  readonly kind: `child.lifecycle.${ChildThreadLifecycle}`;
  readonly payload: ChildThreadLifecycleNotification;
};

const isChildThreadLifecycleNotification = Schema.is(ChildThreadLifecycleNotification);

export function childLifecycleNotificationToActivity(input: {
  readonly eventId: EventId;
  readonly payload: ChildThreadLifecycleNotification;
  readonly sequence?: number;
}): ChildLifecycleThreadActivity {
  const presentation = CHILD_LIFECYCLE_ACTIVITY_PRESENTATION[input.payload.lifecycle];
  return {
    id: input.eventId,
    tone: presentation.tone,
    kind: `child.lifecycle.${input.payload.lifecycle}`,
    summary: `${input.payload.childTitle} ${presentation.summarySuffix}`,
    payload: input.payload,
    turnId: null,
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    createdAt: input.payload.createdAt,
  };
}

export function isChildLifecycleThreadActivity(
  activity: OrchestrationThreadActivity,
): activity is ChildLifecycleThreadActivity {
  return (
    isChildThreadLifecycleNotification(activity.payload) &&
    activity.kind === `child.lifecycle.${activity.payload.lifecycle}`
  );
}

export function isTurnLifecycleInsightActivity(activity: OrchestrationThreadActivity): boolean {
  return TURN_LIFECYCLE_INSIGHT_KINDS.has(activity.kind);
}
