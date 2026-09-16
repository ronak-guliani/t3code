import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { AlertTriangle } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const POST_COMPLETION_WARNING_CODE = "copilot-acp-post-completion-activity";

const BADGE_LABEL = "Copilot continued after completion";
const BADGE_TOOLTIP =
  "Copilot activity continued after completion. Background work may still be running. Review the session before sending or interrupting; later edits may be missing from the completion checkpoint.";

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
    <div className="flex justify-start px-3 pt-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="alert"
              aria-label={BADGE_TOOLTIP}
              className="inline-flex max-w-full cursor-default select-none items-center gap-1.5 py-0.5 text-[11px] leading-tight text-muted-foreground"
            >
              <AlertTriangle className="size-3 shrink-0 text-warning/70" aria-hidden />
              <span className="truncate decoration-muted-foreground/40 decoration-dotted underline-offset-[3px] hover:underline">
                {BADGE_LABEL}
              </span>
            </span>
          }
        />
        <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-snug">
          {BADGE_TOOLTIP}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
