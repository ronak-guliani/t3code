import type { PullRequestListEntry } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestMetaLine,
  PullRequestStateGlyph,
  pullRequestLabelColor,
} from "./pullRequestPresentation";

const LABEL_SLOTS = [
  { pill: "", overflow: "@xl/pr-row-meta:hidden" },
  { pill: "hidden @xl/pr-row-meta:inline-flex", overflow: "@3xl/pr-row-meta:hidden" },
  { pill: "hidden @3xl/pr-row-meta:inline-flex", overflow: "" },
] as const;

function PullRequestRowLabels({ labels }: { readonly labels: PullRequestListEntry["labels"] }) {
  if (labels.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {LABEL_SLOTS.map((slot, index) => {
        const label = labels[index];
        if (!label) return null;
        const remaining = labels.length - index - 1;
        return (
          <span
            key={label.name}
            className={cn(
              "inline-flex max-w-40 min-w-0 items-center gap-1 rounded-full border border-border/70 bg-muted/40 py-0 pr-1.5 pl-1 text-[10px] leading-3.5 text-muted-foreground",
              slot.pill,
            )}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-muted-foreground"
              {...(pullRequestLabelColor(label.color)
                ? { style: { backgroundColor: pullRequestLabelColor(label.color)! } }
                : {})}
            />
            <span className="truncate">{label.name}</span>
            {remaining > 0 ? (
              <span className={cn("shrink-0", slot.overflow)}>+{remaining}</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

function PullRequestRowImpl({
  entry,
  selected,
  matchedElsewhere,
  onSelect,
  onHoverStart,
  onHoverEnd,
  onFocusRow,
}: {
  readonly entry: PullRequestListEntry;
  readonly selected: boolean;
  /**
   * A search found this, but in something the row does not show — a
   * description, a comment, a commit message.
   */
  readonly matchedElsewhere?: boolean;
  readonly onSelect: (entry: PullRequestListEntry) => void;
  /**
   * Warm the detail before it opens. Hover is delayed by the route so crossing
   * rows costs nothing; keyboard focus prefetches at once because focus is
   * already intentional.
   */
  readonly onHoverStart?: (entry: PullRequestListEntry) => void;
  readonly onHoverEnd?: () => void;
  readonly onFocusRow?: (entry: PullRequestListEntry) => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(entry)}
      onPointerEnter={onHoverStart ? () => onHoverStart(entry) : undefined}
      onPointerLeave={onHoverEnd}
      onFocus={onFocusRow ? () => onFocusRow(entry) : undefined}
      onBlur={onHoverEnd}
      className={cn(
        "@container/pr-row grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // Offscreen rows are skipped for style, layout and paint: a long list
        // costs what the viewport shows, not what the pages have loaded.
        "[contain-intrinsic-block-size:66px] [content-visibility:auto]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <PullRequestStateGlyph
        state={entry.state}
        isDraft={entry.isDraft}
        mergeability={entry.mergeability}
        baseBranch={entry.baseBranch}
      />
      <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
        <span className="col-start-1 row-start-1 block truncate text-sm font-medium text-foreground">
          {entry.title}
        </span>
        <span className="col-start-2 row-start-1 flex items-center justify-self-end gap-2 text-xs">
          {entry.viewerReviewRequested ? (
            <span className="min-w-0 truncate text-amber-600/90 dark:text-amber-400/80">
              Review requested
            </span>
          ) : null}
          <PullRequestDiffStat
            additions={entry.additions}
            deletions={entry.deletions}
            className="shrink-0 whitespace-nowrap text-[11px]"
          />
        </span>
        <PullRequestMetaLine className="@container/pr-row-meta col-start-1 row-start-2 overflow-hidden text-xs text-muted-foreground/70">
          {matchedElsewhere ? (
            <span className="flex min-w-6 shrink-0 items-center gap-1 overflow-hidden rounded-full border border-border/60 px-1 text-[10px]">
              <span className="hidden truncate @xs/pr-row-meta:block">matched elsewhere</span>
            </span>
          ) : null}
          <span className="shrink-0 tabular-nums">#{entry.number}</span>
          <span className="truncate">{entry.repository}</span>
          <PullRequestActorLabel
            actor={entry.author}
            className="min-w-4 max-w-40"
            labelClassName="sr-only @xs/pr-row-meta:not-sr-only @xs/pr-row-meta:truncate"
          />
          {entry.labels.length > 0 ? <PullRequestRowLabels labels={entry.labels} /> : null}
        </PullRequestMetaLine>
        <span className="col-start-2 row-start-2 flex items-center justify-self-end gap-3 whitespace-nowrap text-[11px] text-muted-foreground/70 tabular-nums">
          <span className="hidden @sm/pr-row:inline">
            {formatRelativeTimeLabel(entry.updatedAt)}
          </span>
        </span>
      </span>
    </button>
  );
}

/**
 * Memoized: the list re-renders on every keystroke of a search and every
 * status poll, and a row whose entry and selection are unchanged has nothing
 * new to say. Effective because the route hands it a stable `onSelect`.
 */
export const PullRequestRow = memo(PullRequestRowImpl);
