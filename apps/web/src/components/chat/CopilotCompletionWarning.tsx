import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { AlertTriangle } from "lucide-react";

const POST_COMPLETION_WARNING_CODE = "copilot-acp-post-completion-activity";

export function CopilotCompletionWarning({
  activities,
}: {
  activities?: readonly OrchestrationThreadActivity[] | undefined;
}) {
  const warning = (activities ?? []).find((activity) => {
    if (activity.kind !== "runtime.warning") return false;
    const detail = (activity.payload as { detail?: { code?: unknown } } | null | undefined)?.detail;
    return detail?.code === POST_COMPLETION_WARNING_CODE;
  });
  if (!warning) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs"
    >
      <AlertTriangle
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Copilot activity continued after completion</p>
        <p className="mt-1 text-muted-foreground">
          Background work may still be running. Review the session before sending or interrupting;
          later edits may be missing from the completion checkpoint.
        </p>
      </div>
    </div>
  );
}
