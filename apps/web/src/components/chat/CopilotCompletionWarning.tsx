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
      className="flex items-start gap-2 rounded-t-[19px] border-b border-warning/25 bg-warning/4 px-3 py-2 text-[11px] leading-snug"
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-warning-foreground">
          Copilot activity continued after completion{" "}
          <span className="font-normal text-muted-foreground">
            Background work may still be running. Review the session before sending or interrupting;
            later edits may be missing from the completion checkpoint.
          </span>
        </p>
      </div>
    </div>
  );
}
