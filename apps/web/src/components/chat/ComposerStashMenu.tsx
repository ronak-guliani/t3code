import type { OrchestrationQueuedTurn } from "@t3tools/contracts";
import { BookmarkIcon, Clock3Icon, XIcon } from "lucide-react";
import { memo } from "react";

import { type PromptStashEntry } from "../../promptStashStore";
import { Button } from "../ui/button";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "../ui/command";

function snippet(prompt: string, fallback: string): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return fallback;
  return normalized.length > 90 ? `${normalized.slice(0, 90)}...` : normalized;
}

export const ComposerStashMenu = memo(function ComposerStashMenu(props: {
  scheduled: ReadonlyArray<OrchestrationQueuedTurn>;
  saved: ReadonlyArray<PromptStashEntry>;
  onRestoreSaved: (entry: PromptStashEntry) => void;
  onDeleteSaved: (entry: PromptStashEntry) => void;
}) {
  const { scheduled, saved, onRestoreSaved, onDeleteSaved } = props;
  return (
    <Command autoHighlight={false} mode="none">
      <div className="dropdown-glass relative w-full overflow-hidden rounded-[20px]">
        <CommandList className="max-h-72">
          {scheduled.length > 0 ? (
            <CommandGroup>
              <CommandGroupLabel className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/55">
                <Clock3Icon className="size-3" aria-hidden="true" />
                Up next
              </CommandGroupLabel>
              {scheduled.map((entry, index) => (
                <CommandItem
                  key={entry.id}
                  value={entry.id}
                  className="cursor-default gap-2 hover:bg-transparent hover:text-inherit"
                >
                  <span className="shrink-0 text-xs text-muted-foreground">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {snippet(
                      entry.message.text,
                      `${entry.message.attachments.length} image prompt`,
                    )}
                  </span>
                  {entry.failedAt !== null ? (
                    <span className="shrink-0 text-[10px] text-destructive">Paused</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          <CommandGroup>
            <CommandGroupLabel className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/55">
              <BookmarkIcon className="size-3" aria-hidden="true" />
              Saved
            </CommandGroupLabel>
            {saved.length === 0 ? (
              <p className="px-3 pb-3 pt-1 text-xs text-muted-foreground/70">
                Press ⌘S with a prompt in the composer to save it here.
              </p>
            ) : (
              saved.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={entry.id}
                  className="group/stash cursor-pointer gap-2 hover:bg-transparent hover:text-inherit"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onRestoreSaved(entry)}
                >
                  <BookmarkIcon className="size-4 shrink-0 text-muted-foreground/60" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {snippet(
                      entry.prompt,
                      `(${entry.attachments.length + entry.droppedImageNames.length} images)`,
                    )}
                  </span>
                  {entry.droppedImageNames.length > 0 ? (
                    <span className="shrink-0 text-[10px] text-amber-600">
                      {entry.droppedImageNames.length} dropped
                    </span>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 opacity-0 transition-opacity group-hover/stash:opacity-100"
                    aria-label="Delete saved prompt"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteSaved(entry);
                    }}
                  >
                    <XIcon />
                  </Button>
                </CommandItem>
              ))
            )}
          </CommandGroup>
        </CommandList>
      </div>
    </Command>
  );
});
