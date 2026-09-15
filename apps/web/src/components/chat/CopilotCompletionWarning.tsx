import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { AlertTriangle } from "lucide-react";
import { cn } from "~/lib/utils";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
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
    <div className="flex justify-start px-3 pt-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="alert"
              aria-label={BADGE_TOOLTIP}
              className={cn(
                COMPOSER_INLINE_CHIP_CLASS_NAME,
                "cursor-default border-warning/30 bg-warning/8 text-warning-foreground",
              )}
            >
              <AlertTriangle
                className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "text-warning opacity-100")}
                aria-hidden
              />
              <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{BADGE_LABEL}</span>
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
