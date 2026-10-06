import type { ThreadContextRecord } from "@t3tools/contracts";
import { memo } from "react";
import { MessagesSquareIcon, XIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useStore } from "~/store";
import { toastManager } from "../ui/toast";

import { cn } from "~/lib/utils";
import { COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME } from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ThreadContextChip = memo(function ThreadContextChip(props: {
  record: ThreadContextRecord;
  liveTitle?: string | null | undefined;
  disabled?: boolean | undefined;
  navigateOnClick?: boolean | undefined;
  onRemove?: ((contextId: ThreadContextRecord["contextId"]) => void) | undefined;
}) {
  const liveTitle = useStore(
    (state) =>
      state.environmentStateById[props.record.environmentId]?.threadShellById[props.record.threadId]
        ?.title ?? null,
  );
  const currentTitle = props.liveTitle ?? liveTitle;
  const environmentKnown = useStore((state) =>
    Boolean(state.environmentStateById[props.record.environmentId]),
  );
  const threadShell = useStore(
    (state) =>
      state.environmentStateById[props.record.environmentId]?.threadShellById[
        props.record.threadId
      ],
  );
  const title = currentTitle?.trim().length
    ? currentTitle.trim()
    : props.record.title?.trim().length
      ? props.record.title
      : props.record.label;
  const className = cn(
    "group inline-flex h-[1.41em] max-w-60 select-none items-center gap-[0.33em] rounded-[0.5em] border border-teal-600/25 bg-teal-600/10 px-[0.5em] align-middle font-medium text-[0.86em] leading-none text-teal-800 dark:text-teal-300",
    props.navigateOnClick && "hover:bg-teal-600/15 no-underline",
  );
  const contents = (
    <>
      <MessagesSquareIcon aria-hidden="true" className="size-[1.17em] shrink-0" />
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </>
  );
  const chip = props.navigateOnClick ? (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: props.record.environmentId, threadId: props.record.threadId }}
      className={className}
      aria-label={`Open thread ${title}`}
      data-thread-context-chip={String(props.record.contextId)}
      title={title}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        if (!environmentKnown) {
          event.preventDefault();
          toastManager.add({
            type: "error",
            title: "Thread environment unavailable",
            description: `Connect environment ${props.record.environmentId} before opening this thread.`,
          });
          return;
        }
        if (threadShell?.archivedAt) {
          event.preventDefault();
          toastManager.add({
            type: "error",
            title: "Thread is archived",
            description: "Restore the archived thread before opening it from chat.",
          });
        }
      }}
    >
      {contents}
    </Link>
  ) : (
    <span
      className={className}
      data-thread-context-chip={String(props.record.contextId)}
      title={title}
    >
      {contents}
      {props.onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${title}`}
          disabled={props.disabled}
          tabIndex={-1}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onRemove?.(props.record.contextId);
          }}
          className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
        >
          <XIcon aria-hidden="true" className="size-3" />
        </button>
      ) : null}
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top">{title}</TooltipPopup>
    </Tooltip>
  );
});
