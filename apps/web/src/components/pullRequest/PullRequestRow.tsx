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

function PullRequestRowLabels({ labels }: { readonly labels: PullRequestListEntry["labels"] }) {
  if (labels.length === 0) return null;
  const [first, second] = labels;
  const remaining = labels.length - (second ? 2 : 1);
  return (
    <span className="flex min-w-0 items-center gap-1">
      {first ? (
        <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-muted-foreground"
            {...(pullRequestLabelColor(first.color)
              ? { style: { backgroundColor: pullRequestLabelColor(first.color)! } }
              : {})}
          />
          <span className="truncate">{first.name}</span>
        </span>
      ) : null}
      {second ? (
        <span className="hidden min-w-0 items-center gap-1 text-muted-foreground @sm/pr-row:inline-flex">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-muted-foreground"
            {...(pullRequestLabelColor(second.color)
              ? { style: { backgroundColor: pullRequestLabelColor(second.color)! } }
              : {})}
          />
          <span className="truncate">{second.name}</span>
        </span>
      ) : null}
      {remaining > 0 ? <span className="shrink-0">+{remaining}</span> : null}
    </span>
  );
}

function PullRequestRowImpl({
  entry,
  selected,
  matchedElsewhere,
  onSelect,
}: {
  readonly entry: PullRequestListEntry;
  readonly selected: boolean;
  /**
   * A search found this, but in something the row does not show — a
   * description, a comment, a commit message.
   */
  readonly matchedElsewhere?: boolean;
  readonly onSelect: (entry: PullRequestListEntry) => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(entry)}
      className={cn(
        "@container/pr-row grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-[7px] text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // Offscreen rows are skipped for style, layout and paint: a long list
        // costs what the viewport shows, not what the pages have loaded.
        "[contain-intrinsic-block-size:44px] [content-visibility:auto]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <PullRequestStateGlyph
        state={entry.state}
        isDraft={entry.isDraft}
        mergeability={entry.mergeability}
        baseBranch={entry.baseBranch}
        className="size-3.5"
      />
      <span className="grid min-w-0 gap-y-0.5">
        <span className="block truncate text-[13px] leading-5 font-medium text-foreground">
          {entry.title}
        </span>
        <PullRequestMetaLine className="overflow-hidden text-[11px] leading-4 text-muted-foreground">
          <span className="shrink-0 tabular-nums">#{entry.number}</span>
          <span className="truncate">{entry.repository}</span>
          <PullRequestActorLabel actor={entry.author} className="min-w-0 max-w-32" />
          {entry.labels.length > 0 ? <PullRequestRowLabels labels={entry.labels} /> : null}
          {matchedElsewhere ? (
            <span className="shrink-0 text-[10px]">matched elsewhere</span>
          ) : null}
        </PullRequestMetaLine>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-y-0.5 pl-1">
        <PullRequestDiffStat
          additions={entry.additions}
          deletions={entry.deletions}
          className="text-[11px] leading-4 whitespace-nowrap"
        />
        <span className="text-[10px] leading-4 whitespace-nowrap text-muted-foreground tabular-nums">
          {formatRelativeTimeLabel(entry.updatedAt)}
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
