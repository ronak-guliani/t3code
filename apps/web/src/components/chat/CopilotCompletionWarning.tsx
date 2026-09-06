import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { AlertTriangle, X } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { Button } from "../ui/button";

const EMPTY_ACTIVITIES: readonly OrchestrationThreadActivity[] = [];

export const CopilotCompletionWarning = memo(function CopilotCompletionWarning({
  activities = EMPTY_ACTIVITIES,
}: {
  activities?: readonly OrchestrationThreadActivity[] | undefined;
}) {
  const [dismissedId, setDismissedId] = useState<string | null>(null);
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
  if (!warning || warning.id === dismissedId) return null;

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
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss Copilot completion warning"
        onClick={() => setDismissedId(warning.id)}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
});
