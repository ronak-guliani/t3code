import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { AlertTriangle, X } from "lucide-react";
import { memo, useMemo } from "react";
import { useUiStateStore } from "../../uiStateStore";
import { Button } from "../ui/button";

const EMPTY_ACTIVITIES: readonly OrchestrationThreadActivity[] = [];

export const CopilotCompletionWarning = memo(function CopilotCompletionWarning({
  activities = EMPTY_ACTIVITIES,
}: {
  activities?: readonly OrchestrationThreadActivity[] | undefined;
}) {
  const warning = useMemo(
    () =>
      activities.findLast((activity) => {
        if (activity.kind !== "runtime.warning") return false;
        const payload = activity.payload;
        if (typeof payload !== "object" || payload === null || !("detail" in payload)) return false;
        const detail = payload.detail;
        return (
          typeof detail === "object" &&
          detail !== null &&
          "code" in detail &&
          detail.code === "copilot-acp-post-completion-activity"
        );
      }),
    [activities],
  );
  const dismissed = useUiStateStore(
    (state) => warning !== undefined && state.dismissedCopilotWarningIds.has(warning.id),
  );
  if (!warning || dismissed) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-amber-500/20 bg-amber-500/[0.06] px-4 py-2 text-xs"
    >
      <AlertTriangle
        className="mt-0.5 size-3.5 shrink-0 text-amber-600/80 dark:text-amber-400/80"
        aria-hidden
      />
      <div className="min-w-0 flex-1 leading-5">
        <p className="inline font-medium text-foreground/90">
          Copilot activity continued after completion
        </p>{" "}
        <p className="inline text-foreground/70">
          Background work may still be running. Review the session before sending or interrupting;
          later edits may be missing from the completion checkpoint.
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground/60 hover:text-foreground/80"
        aria-label="Dismiss Copilot completion warning"
        onClick={() => useUiStateStore.getState().dismissCopilotWarning(warning.id)}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
});
