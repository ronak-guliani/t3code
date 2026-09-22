import type {
  PullRequestActor,
  PullRequestCheckStatus,
  PullRequestMergeability,
  PullRequestMergeMethod,
  PullRequestState,
} from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Children, isValidElement, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * How a pull request's state reads on this page. Draft outranks conflicts: a
 * draft is not heading for a merge yet, so conflicts only surface once it is
 * real work.
 */
export function pullRequestStatePresentation(input: {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability?: PullRequestMergeability;
  readonly baseBranch?: string;
}) {
  if (input.state === "merged") {
    return {
      label: "Merged",
      Icon: GitMergeIcon,
      className: "text-violet-600 dark:text-violet-300/90",
    };
  }
  if (input.state === "closed") {
    return {
      label: "Closed",
      Icon: GitPullRequestClosedIcon,
      className: "text-red-600 dark:text-red-300/90",
    };
  }
  if (input.isDraft) {
    return {
      label: "Draft",
      Icon: GitPullRequestDraftIcon,
      className: "text-zinc-500 dark:text-zinc-400/80",
    };
  }
  if (input.mergeability === "conflicting") {
    return {
      label: input.baseBranch ? `Conflicts with ${input.baseBranch}` : "Conflicting",
      Icon: TriangleAlertIcon,
      className: "text-destructive",
    };
  }
  return {
    label: "Open",
    Icon: GitPullRequestIcon,
    className: "text-emerald-600 dark:text-emerald-300/90",
  };
}

export function PullRequestStateGlyph({
  state,
  isDraft,
  mergeability,
  baseBranch,
  className,
}: {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability?: PullRequestMergeability;
  readonly baseBranch?: string;
  readonly className?: string;
}) {
  const presentation = pullRequestStatePresentation({
    state,
    isDraft,
    ...(mergeability ? { mergeability } : {}),
    ...(baseBranch ? { baseBranch } : {}),
  });
  return (
    <Tooltip>
      {/* The list row is itself a button, so the trigger stays a span: an
          interactive one would nest a control inside that button. */}
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-4 shrink-0", presentation.className, className)}
        />
      </TooltipTrigger>
      <TooltipPopup>{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}

export function PullRequestActorAvatar({
  actor,
  className,
}: {
  readonly actor: PullRequestActor | null;
  readonly className?: string;
}) {
  const login = actor?.login ?? "ghost";
  if (!actor?.avatarUrl) {
    // Not every host reports an avatar, so the initial stands in where none arrives.
    return (
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-medium text-muted-foreground",
          className,
        )}
      >
        {login.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      alt=""
      aria-hidden
      className={cn("size-4 shrink-0 rounded-full bg-muted object-cover", className)}
      loading="lazy"
      src={actor.avatarUrl}
    />
  );
}

/** GitHub attributes work from a deleted account to "ghost"; say the same word everywhere. */
export function PullRequestActorLabel({
  actor,
  className,
  labelClassName,
  tooltip = true,
}: {
  readonly actor: PullRequestActor | null;
  readonly className?: string;
  readonly labelClassName?: string;
  readonly tooltip?: boolean;
}) {
  const login = actor?.login ?? "ghost";
  const label = (
    <>
      <PullRequestActorAvatar actor={actor} />
      <span className={cn("truncate", labelClassName)}>{login}</span>
    </>
  );
  if (!tooltip) {
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>{label}</span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top">{login}</TooltipPopup>
    </Tooltip>
  );
}

export function PullRequestDiffStat({
  additions,
  deletions,
  className,
}: {
  readonly additions: number;
  readonly deletions: number;
  readonly className?: string;
}) {
  // Zero means the host has not reported counts (or there are none); showing
  // "+0 -0" would read as an empty change set rather than a missing one.
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className={cn("inline-flex items-baseline gap-1 tabular-nums", className)}>
      <span className="text-emerald-600 dark:text-emerald-300">+{additions.toLocaleString()}</span>
      <span className="text-destructive">-{deletions.toLocaleString()}</span>
    </span>
  );
}

/**
 * Dot-separated metadata. It owns the separator, and draws one only between
 * the segments that survive, so a caller can render
 * `{condition ? <span/> : null}` without leaving a stray dot.
 */
function separatorKey(segment: ReactNode): string {
  return `separator:${isValidElement(segment) ? String(segment.key) : String(segment)}`;
}

export function PullRequestMetaLine({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const segments = Children.toArray(children);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {segments.flatMap((segment, index) =>
        index === 0
          ? segment
          : [
              <span
                aria-hidden
                className="shrink-0 text-muted-foreground/50"
                key={separatorKey(segment)}
              >
                ·
              </span>,
              segment,
            ],
      )}
    </span>
  );
}

/**
 * The verdict a submitted review carries, read the way the host reports it.
 * Approvals and change requests must not wear the same badge: a timeline
 * where they do makes every review read as mere discussion. A null variant
 * means the plain "Review" label rather than a verdict pill.
 */
export function pullRequestReviewVerdictPresentation(reviewState: string | null): {
  readonly label: string;
  readonly variant: "success" | "error" | "outline" | null;
} {
  switch (reviewState?.toUpperCase()) {
    case "APPROVED":
      return { label: "Approved", variant: "success" };
    case "CHANGES_REQUESTED":
      return { label: "Changes requested", variant: "error" };
    case "DISMISSED":
      return { label: "Review dismissed", variant: "outline" };
    default:
      return { label: "Review", variant: null };
  }
}

/**
 * Normalizes a label color to a CSS color, or null when it is absent. Label
 * colors arrive as bare hex without the leading `#`.
 */
export function pullRequestLabelColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const hex = color.startsWith("#") ? color : `#${color}`;
  return /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(hex) ? hex : null;
}

const HTML_ENTITY_PATTERN = /&(amp|lt|gt|quot|#39);/g;
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(HTML_ENTITY_PATTERN, (match) => HTML_ENTITIES[match.slice(1, -1)] ?? match);
}

/**
 * Copilot and GitHub review bodies arrive as Markdown mixed with HTML
 * (`<details>`, `<summary>`, `<a href>`, `<br>`). `ChatMarkdown` renders
 * Markdown without raw HTML, so without this the page shows literal tags.
 * Convert the common shapes to Markdown and strip anything else.
 *
 * Fenced code blocks (``` or ~~~, including longer runs) and inline code
 * spans are passed through untouched so HTML-like samples inside them are
 * never rewritten.
 */
export function toRenderablePullRequestMarkdown(body: string): string {
  // Odd segments are fenced blocks (including unterminated blocks); even
  // segments are prose, where inline code spans (single or multi-backtick)
  // must remain untouched too.
  return splitFencedCodeBlocks(body)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment
            .split(/(`+[^`\n]*?`+)/g)
            .map((inlineSegment, inlineIndex) =>
              inlineIndex % 2 === 1 ? inlineSegment : transformPullRequestMarkdown(inlineSegment),
            )
            .join(""),
    )
    .join("")
    .trim();
}

function splitFencedCodeBlocks(body: string): string[] {
  const segments: string[] = [];
  const openingFence = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/gm;
  let proseStart = 0;

  for (const opening of body.matchAll(openingFence)) {
    if (opening.index === undefined || opening.index < proseStart) continue;
    const fence = opening[1]!;
    const closingFence = new RegExp(
      `^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n|$)`,
      "gm",
    );
    closingFence.lastIndex = opening.index + opening[0].length;
    const closing = closingFence.exec(body);
    const fenceEnd = closing ? closingFence.lastIndex : body.length;

    segments.push(body.slice(proseStart, opening.index), body.slice(opening.index, fenceEnd));
    proseStart = fenceEnd;
  }

  segments.push(body.slice(proseStart));
  return segments;
}

function transformPullRequestMarkdown(body: string): string {
  let text = body;
  text = text.replace(/<img\b([^>]*)>/gi, (_match, attributes: string) => {
    const source = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2];
    if (!source || !/^https?:\/\//i.test(source)) {
      return "";
    }
    const alt = /\balt\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2] ?? "image";
    const label = alt.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
    const href = source.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
    return `![${label}](${href})`;
  });
  text = text.replace(/<details\b[^>]*>([\s\S]*?)<\/details>/gi, (_match, inner: string) => {
    const summary = inner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ?? "";
    const rest = inner.replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, "");
    const heading = summary
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return `\n\n${heading ? `### ${heading}\n\n` : ""}${rest}\n\n`;
  });
  text = text.replace(
    /<a\s[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, _quote: string, href: string, label: string) => {
      const cleanLabel =
        label
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .replaceAll("\\", "\\\\")
          .replaceAll("[", "\\[")
          .replaceAll("]", "\\]") || href;
      const cleanHref = href.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
      return `[${cleanLabel}](${cleanHref})`;
    },
  );
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/?(summary|div|span|p|table|thead|tbody|tr|td|th)[^>]*>/gi, "\n");
  // Preserve Markdown autolinks (`<https://example.com>`, `<mailto:…>`,
  // `<user@example.com>`) by converting them to explicit links before the
  // generic tag strip below would otherwise delete them entirely.
  text = text.replace(
    /<(?:([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}))>/g,
    (_match, uri: string | undefined, email: string | undefined) => {
      const target = uri ?? email!;
      const href = uri ?? `mailto:${email}`;
      const cleanLabel = target
        .replaceAll("\\", "\\\\")
        .replaceAll("[", "\\[")
        .replaceAll("]", "\\]");
      const cleanHref = href.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
      return `[${cleanLabel}](${cleanHref})`;
    },
  );
  text = text.replace(/<[^>]+>/g, "");
  text = decodeHtmlEntities(text);
  // No trailing trim here: segments are joined before trimming so whitespace
  // adjacent to preserved code spans survives.
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

const CHECK_STATUS_PRESENTATION = {
  pending: { label: "Running", Icon: CircleDotIcon, toneClassName: "text-amber-500" },
  success: {
    label: "Passed",
    Icon: CircleCheckIcon,
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
  },
  failure: { label: "Failed", Icon: CircleXIcon, toneClassName: "text-destructive" },
  cancelled: { label: "Cancelled", Icon: CircleXIcon, toneClassName: "text-destructive" },
  skipped: {
    label: "Skipped",
    Icon: CircleDashedIcon,
    toneClassName: "text-muted-foreground/70",
  },
  neutral: {
    label: "Neutral",
    Icon: CircleDashedIcon,
    toneClassName: "text-muted-foreground/70",
  },
} as const satisfies Record<
  PullRequestCheckStatus,
  { label: string; Icon: typeof CircleCheckIcon; toneClassName: string }
>;

export function pullRequestCheckStatusLabel(status: PullRequestCheckStatus): string {
  return CHECK_STATUS_PRESENTATION[status].label;
}

export function PullRequestCheckStatusIcon({
  status,
}: {
  readonly status: PullRequestCheckStatus;
}) {
  const presentation = CHECK_STATUS_PRESENTATION[status];
  return (
    <presentation.Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", presentation.toneClassName)}
    />
  );
}

export interface PullRequestCheckSummary {
  readonly passing: number;
  readonly failing: number;
  readonly pending: number;
  readonly cancelled: number;
  readonly total: number;
}

/**
 * Bucket check statuses with the same semantics as the server readiness
 * computation (`readiness.ts`): `neutral`/`skipped` pass, `pending` waits,
 * `cancelled` blocks separately from `failure`.
 */
export function summarizePullRequestChecks(
  checks: readonly { readonly status: PullRequestCheckStatus }[],
): PullRequestCheckSummary {
  const summary = { passing: 0, failing: 0, pending: 0, cancelled: 0, total: checks.length };
  for (const check of checks) {
    if (check.status === "success" || check.status === "neutral" || check.status === "skipped") {
      summary.passing += 1;
    } else if (check.status === "pending") {
      summary.pending += 1;
    } else if (check.status === "cancelled") {
      summary.cancelled += 1;
    } else {
      summary.failing += 1;
    }
  }
  return summary;
}

export function pullRequestCheckSummaryLabel(summary: PullRequestCheckSummary): string {
  if (summary.total === 0) return "No checks";
  const parts = [`${summary.passing} passing`];
  if (summary.failing > 0) parts.push(`${summary.failing} failing`);
  if (summary.cancelled > 0) parts.push(`${summary.cancelled} cancelled`);
  if (summary.pending > 0) parts.push(`${summary.pending} pending`);
  return parts.join(" · ");
}

export function pullRequestCheckDotClassName(status: PullRequestCheckStatus): string {
  if (status === "success" || status === "neutral" || status === "skipped") {
    return "text-emerald-500";
  }
  if (status === "failure" || status === "cancelled") {
    return "text-destructive";
  }
  return "text-muted-foreground";
}

export function pullRequestActionLabel(
  action: "merge" | "ready" | "draft" | "close" | "reopen",
): string {
  switch (action) {
    case "merge":
      return "Merge";
    case "ready":
      return "Mark ready";
    case "draft":
      return "Convert to draft";
    case "close":
      return "Close";
    case "reopen":
      return "Reopen";
  }
}

export interface PullRequestMergeSelection {
  readonly allowedMergeMethods: readonly PullRequestMergeMethod[];
  readonly selectedMergeMethod: PullRequestMergeMethod | null;
  readonly showMergeMethodPicker: boolean;
}

/**
 * Merge-strategy selection for the PR summary actions. The host reports every
 * method it knows plus per-method availability; the picker offers only the
 * allowed ones and falls back to the first allowed method when the reviewer's
 * override is missing or no longer allowed. The picker shows only when merge
 * itself is available and there is a real choice to make. The selected method
 * is the `mergeMethod` sent with the destructive merge request.
 */
export function resolvePullRequestMergeSelection(input: {
  readonly canMerge: boolean;
  readonly mergeMethods: readonly PullRequestMergeMethod[];
  readonly mergeCapabilities: Record<PullRequestMergeMethod, boolean>;
  readonly override: PullRequestMergeMethod | null;
}): PullRequestMergeSelection {
  const allowedMergeMethods = input.mergeMethods.filter(
    (method) => input.mergeCapabilities[method],
  );
  const selectedMergeMethod =
    (input.override && allowedMergeMethods.includes(input.override)
      ? input.override
      : allowedMergeMethods[0]) ?? null;
  return {
    allowedMergeMethods,
    selectedMergeMethod,
    showMergeMethodPicker: input.canMerge && allowedMergeMethods.length > 1,
  };
}
