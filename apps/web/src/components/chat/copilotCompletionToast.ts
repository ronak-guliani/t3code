import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export const COPILOT_POST_COMPLETION_WARNING_CODE = "copilot-acp-post-completion-activity";

export const COPILOT_COMPLETION_TOAST_TITLE = "Copilot continued after completion";
export const COPILOT_COMPLETION_TOAST_DESCRIPTION =
  "Copilot activity continued after completion. Background work may still be running. Review the session before sending or interrupting; later edits may be missing from the completion checkpoint.";

export function hasCopilotPostCompletionWarning(
  activities: readonly OrchestrationThreadActivity[] | undefined,
): boolean {
  return (activities ?? []).some((activity) => {
    if (activity.kind !== "runtime.warning") return false;
    const detail = (activity.payload as { detail?: { code?: unknown } } | null | undefined)?.detail;
    return detail?.code === COPILOT_POST_COMPLETION_WARNING_CODE;
  });
}
