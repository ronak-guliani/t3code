import type {
  GitPullRequestAssociation,
  ScopedThreadRef,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { sameThreadPullRequest } from "@t3tools/shared/threadPullRequests";
import { GitPullRequestIcon } from "lucide-react";

import { openPullRequestLink } from "../lib/openPullRequestLink";
import { cn } from "../lib/utils";
import { prStatusIndicator } from "./ThreadStatusIndicators";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover";

export function resolveThreadPullRequests(
  links: ReadonlyArray<ThreadPullRequestLink> | undefined,
  fallbackPullRequest: GitPullRequestAssociation | null | undefined,
): ReadonlyArray<GitPullRequestAssociation> {
  // Most-recent-first: later links were appended as they were created, so
  // reverse insertion order and break linkedAt ties by position. A distinct
  // legacy fallback is the oldest association, so it goes last.
  const recentFirst = (links ?? [])
    .map((link, index) => ({ link, index }))
    .sort((left, right) => {
      const byLinkedAt = right.link.linkedAt.localeCompare(left.link.linkedAt);
      return byLinkedAt !== 0 ? byLinkedAt : right.index - left.index;
    })
    .map(({ link }) => link.pullRequest);
  if (
    !fallbackPullRequest ||
    recentFirst.some((pullRequest) => sameThreadPullRequest(pullRequest, fallbackPullRequest))
  ) {
    return recentFirst;
  }
  return [...recentFirst, fallbackPullRequest];
}

export function formatThreadPullRequestSummary(
  pullRequests: ReadonlyArray<GitPullRequestAssociation>,
): string | null {
  const primaryPullRequest = pullRequests[0];
  if (!primaryPullRequest) {
    return null;
  }
  const additionalCount = pullRequests.length - 1;
  return `#${primaryPullRequest.number}${additionalCount > 0 ? ` + ${additionalCount}` : ""}`;
}

export function ThreadPullRequestsPopover({
  links,
  fallbackPullRequest,
  threadRef,
}: {
  readonly links: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly fallbackPullRequest: GitPullRequestAssociation | null | undefined;
  readonly threadRef?: ScopedThreadRef;
}) {
  const pullRequests = resolveThreadPullRequests(links, fallbackPullRequest);
  const primaryPullRequest = pullRequests[0];
  const summary = formatThreadPullRequestSummary(pullRequests);
  if (!primaryPullRequest || !summary) {
    return null;
  }

  const primaryStatus = prStatusIndicator(primaryPullRequest);
  const accessibilityLabel =
    pullRequests.length === 1
      ? `${primaryStatus?.tooltip ?? summary}. Open linked pull request details`
      : `${pullRequests.length} linked pull requests, starting with #${primaryPullRequest.number}. Show details`;
  const triggerClassName = cn(
    "shrink-0 cursor-pointer whitespace-nowrap font-mono tabular-nums outline-hidden transition-colors hover:underline focus-visible:ring-1 focus-visible:ring-ring",
    primaryStatus?.colorClass ?? "text-sky-600 dark:text-sky-300/90",
  );
  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  if (pullRequests.length === 1) {
    return (
      <button
        type="button"
        data-thread-selection-safe
        aria-label={accessibilityLabel}
        title={accessibilityLabel}
        className={triggerClassName}
        onPointerDown={handlePointerDown}
        onClick={(event) => {
          openPullRequestLink(event, primaryPullRequest.url, threadRef);
        }}
      >
        {summary}
      </button>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-thread-selection-safe
            aria-label={accessibilityLabel}
            title={accessibilityLabel}
            className={triggerClassName}
            onPointerDown={handlePointerDown}
            onClick={(event) => {
              event.stopPropagation();
            }}
            onDoubleClick={(event) => {
              openPullRequestLink(event, primaryPullRequest.url, threadRef);
            }}
          />
        }
      >
        {summary}
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="start"
        className="w-[min(22rem,calc(100vw-2rem))] p-0"
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <PopoverTitle className="mb-2 text-xs font-medium text-foreground">
          Linked pull requests
        </PopoverTitle>
        <div className="space-y-1">
          {pullRequests.map((pullRequest, index) => {
            const status = prStatusIndicator(pullRequest);
            return (
              <a
                key={`${pullRequest.url}-${pullRequest.number}`}
                className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                href={pullRequest.url}
                onClick={(event) => {
                  openPullRequestLink(event, pullRequest.url, threadRef);
                }}
              >
                <GitPullRequestIcon
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    status?.colorClass ?? "text-sky-600 dark:text-sky-300/90",
                  )}
                />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 font-mono tabular-nums text-foreground">
                      #{pullRequest.number}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 capitalize",
                        status?.colorClass ?? "text-muted-foreground",
                      )}
                    >
                      {pullRequest.state ?? "unknown"}
                    </span>
                    {index === 0 ? (
                      <span className="truncate text-muted-foreground">Primary</span>
                    ) : null}
                  </span>
                  <span className="line-clamp-2 text-foreground/75">{pullRequest.title}</span>
                </span>
              </a>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
