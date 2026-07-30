import { BookmarkIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

export const ComposerStashBadge = memo(function ComposerStashBadge(props: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  if (props.count === 0) return null;

  return (
    <button
      type="button"
      aria-label={`${props.count} stashed prompt${props.count === 1 ? "" : "s"}. Open stash.`}
      aria-expanded={props.open}
      className={cn(
        "absolute -top-3 right-4 z-10 inline-flex items-center gap-1.5 rounded-full border bg-popover px-2.5 py-0.5 text-xs shadow-sm",
        "transition-[color,border-color,opacity] duration-200",
        props.open
          ? "border-border text-foreground opacity-100"
          : "border-border/70 text-muted-foreground opacity-70 hover:opacity-100 hover:text-foreground",
      )}
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onToggle}
    >
      <BookmarkIcon className="size-3" aria-hidden="true" />
      Stash
      <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
        {props.count}
      </span>
    </button>
  );
});
