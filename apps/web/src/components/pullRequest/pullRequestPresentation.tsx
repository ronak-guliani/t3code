import type {
  PullRequestActor,
  PullRequestCheckStatus,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";

export function pullRequestStatePresentation(input: {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability?: PullRequestMergeability;
}) {
  if (input.state === "merged") {
    return { label: "Merged", Icon: GitMergeIcon, className: "text-violet-500" };
  }
  if (input.state === "closed") {
    return { label: "Closed", Icon: GitPullRequestClosedIcon, className: "text-red-500" };
  }
  if (input.isDraft) {
    return { label: "Draft", Icon: GitPullRequestDraftIcon, className: "text-muted-foreground" };
  }
  if (input.mergeability === "conflicting") {
    return { label: "Conflicting", Icon: TriangleAlertIcon, className: "text-destructive" };
  }
  return { label: "Open", Icon: GitPullRequestIcon, className: "text-emerald-500" };
}

export function PullRequestStateGlyph({
  state,
  isDraft,
  mergeability,
}: {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability?: PullRequestMergeability;
}) {
  const presentation = pullRequestStatePresentation({
    state,
    isDraft,
    ...(mergeability ? { mergeability } : {}),
  });
  return (
    <presentation.Icon
      aria-label={presentation.label}
      className={cn("size-4 shrink-0", presentation.className)}
    />
  );
}

export function PullRequestActorLabel({
  actor,
  className,
}: {
  readonly actor: PullRequestActor | null;
  readonly className?: string;
}) {
  const login = actor?.login ?? "ghost";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} title={login}>
      {actor?.avatarUrl ? (
        <img alt="" className="size-4 rounded-full" loading="lazy" src={actor.avatarUrl} />
      ) : (
        <span className="flex size-4 items-center justify-center rounded-full bg-muted text-[9px]">
          {login.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="truncate">{login}</span>
    </span>
  );
}

export function PullRequestDiffStat({
  additions,
  deletions,
}: {
  readonly additions: number;
  readonly deletions: number;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className="inline-flex gap-1 tabular-nums text-xs">
      <span className="text-emerald-600 dark:text-emerald-300">+{additions}</span>
      <span className="text-destructive">-{deletions}</span>
    </span>
  );
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
  // segments are prose, where inline code spans must remain untouched too.
  return splitFencedCodeBlocks(body)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment
            .split(/(`[^`\n]*`)/g)
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

export function humanizeMonitorToken(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
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
