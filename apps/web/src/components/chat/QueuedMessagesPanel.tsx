import type { OrchestrationQueuedTurn, QueuedTurnId } from "@t3tools/contracts";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { memo } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

interface QueuedMessagesPanelProps {
  queuedTurns: ReadonlyArray<OrchestrationQueuedTurn>;
  editingQueuedTurnId: QueuedTurnId | null;
  editingText: string;
  onStartEditingQueuedTurn: (queuedTurn: OrchestrationQueuedTurn) => void;
  onCancelEditingQueuedTurn: () => void;
  onSaveEditingQueuedTurn: () => void;
  onDeleteQueuedTurn: (queuedTurnId: QueuedTurnId) => void;
}

/**
 * A healthy workspace-handoff continuation is T3 plumbing, not a message the
 * user wrote: editing its boilerplate is meaningless and deleting it would
 * strand the thread in a newly bound worktree with nothing left to run. Failed
 * ones stay visible so the stalled handoff is recoverable.
 */
function isHiddenQueuedTurn(queuedTurn: OrchestrationQueuedTurn): boolean {
  return queuedTurn.origin?.kind === "workspace-handoff" && queuedTurn.failedAt === null;
}

function queuedTurnLabel(queuedTurn: OrchestrationQueuedTurn): string | null {
  return queuedTurn.origin?.kind === "workspace-handoff"
    ? `Continue in ${queuedTurn.origin.branch}`
    : queuedTurn.message.text;
}

function attachmentLabel(queuedTurn: OrchestrationQueuedTurn): string | null {
  const imageCount = queuedTurn.message.attachments.length;
  if (imageCount === 0) {
    return null;
  }
  return `${imageCount} image${imageCount === 1 ? "" : "s"}`;
}

export const QueuedMessagesPanel = memo(function QueuedMessagesPanel({
  queuedTurns,
  editingQueuedTurnId,
  editingText,
  onStartEditingQueuedTurn,
  onCancelEditingQueuedTurn,
  onSaveEditingQueuedTurn,
  onDeleteQueuedTurn,
}: QueuedMessagesPanelProps) {
  // Labels track the real dispatch position: a hidden handoff continuation is
  // still queued ahead of the user's own messages and runs before them.
  const visibleQueuedTurns = queuedTurns.flatMap((queuedTurn, queueIndex) =>
    isHiddenQueuedTurn(queuedTurn) ? [] : [{ queuedTurn, queueIndex }],
  );
  if (visibleQueuedTurns.length === 0) {
    return null;
  }

  return (
    <div className="composer-input-font border-b border-border/55 px-3 py-2">
      <ul className="flex flex-col gap-0.5">
        {visibleQueuedTurns.map(({ queuedTurn, queueIndex }) => {
          const isEditing = editingQueuedTurnId === queuedTurn.id;
          const isPaused = queuedTurn.failedAt !== null;
          const meta = attachmentLabel(queuedTurn);
          const label = queueIndex === 0 ? "Up next" : `Queued ${queueIndex + 1}`;
          return (
            <li
              key={queuedTurn.id}
              className={cn(
                "group -mx-1 rounded-lg px-1 py-1 transition-colors",
                isPaused ? "bg-destructive/5" : "hover:bg-muted/35",
              )}
            >
              {isEditing ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="composer-input-font-secondary font-medium text-muted-foreground">
                      Editing queued message
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={onCancelEditingQueuedTurn}
                      >
                        <X /> Cancel
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        disabled={
                          editingText.trim().length === 0 &&
                          queuedTurn.message.attachments.length === 0
                        }
                        onClick={onSaveEditingQueuedTurn}
                      >
                        <Check /> Save
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      "composer-input-font-secondary w-16 shrink-0 font-medium text-muted-foreground",
                      isPaused ? "text-destructive" : null,
                    )}
                  >
                    {isPaused ? "Paused" : label}
                  </span>
                  <div className="min-w-0 flex-1 truncate text-foreground/85">
                    {queuedTurnLabel(queuedTurn) || (meta ?? "Queued message")}
                    {meta ? (
                      <span className="composer-input-font-secondary ml-2 text-muted-foreground">
                        {meta}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Edit queued message"
                      title="Edit"
                      onClick={() => onStartEditingQueuedTurn(queuedTurn)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Delete queued message"
                      title="Delete"
                      onClick={() => onDeleteQueuedTurn(queuedTurn.id)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              )}
              {!isEditing && isPaused && queuedTurn.failureMessage ? (
                <div className="composer-input-font-secondary ml-[4.625rem] mt-0.5 whitespace-pre-wrap break-words text-destructive">
                  {queuedTurn.failureMessage}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
});
