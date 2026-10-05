import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export const ACTIVITY_APPEND_BATCH_MAX_SIZE = 32;
export const ACTIVITY_APPEND_BATCH_WINDOW_MS = 25;

const BATCHABLE_TOOL_ACTIVITY_KINDS = new Set(["tool.started", "tool.updated", "tool.completed"]);

export function isBatchableToolActivity(
  activity: Pick<OrchestrationThreadActivity, "tone" | "kind">,
): boolean {
  return activity.tone === "tool" && BATCHABLE_TOOL_ACTIVITY_KINDS.has(activity.kind);
}
