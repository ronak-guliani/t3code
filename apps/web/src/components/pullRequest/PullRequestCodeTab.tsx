import type {
  EnvironmentId,
  PullRequestActivity,
  PullRequestDetail,
  PullRequestDiffSide,
  PullRequestRef,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { MAX_PULL_REQUEST_INLINE_REVIEW_COMMENTS } from "@t3tools/contracts";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { CheckIcon, CircleIcon, FileDiffIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { pullRequestDiffInfiniteQueryOptions } from "~/lib/pullRequestReactQuery";
import { buildPatchCacheKey, resolveDiffThemeName } from "~/lib/diffRendering";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useTheme } from "~/hooks/useTheme";
import { useSettings } from "~/hooks/useSettings";
import {
  EMPTY_PENDING_REVIEW_COMMENTS,
  nextPendingReviewCommentId,
  pullRequestReviewKey,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";
import { PullRequestActorLabel, toRenderablePullRequestMarkdown } from "./pullRequestPresentation";

type PullRequestDetailView = PullRequestDetail & PullRequestActivity;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function ReviewThread({
  thread,
  detail,
  pending,
  onReply,
  onResolve,
}: {
  readonly thread: PullRequestReviewThread;
  readonly detail: PullRequestDetailView;
  readonly pending: boolean;
  readonly onReply: (threadId: string, body: string) => Promise<void>;
  readonly onResolve: (threadId: string, resolved: boolean) => void;
}) {
  const [reply, setReply] = useState("");
  const canReply = detail.capabilities.review.reply && detail.viewerPermissions.comment;
  const canResolve = detail.capabilities.review.resolve && detail.viewerPermissions.resolve;

  return (
    <article className="rounded-lg border border-border/70 bg-card p-3 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {thread.isResolved ? (
          <CheckIcon className="size-3.5 text-emerald-500" />
        ) : (
          <CircleIcon className="size-3.5" />
        )}
        <span>
          {thread.isResolved ? "Resolved" : "Open"} · {thread.path}
          {thread.line ? `:${thread.line}` : ""}
          {thread.isOutdated ? " · outdated" : ""}
        </span>
        {canResolve ? (
          <Button
            className="ml-auto"
            disabled={pending}
            size="xs"
            variant="ghost"
            onClick={() => onResolve(thread.id, !thread.isResolved)}
          >
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        ) : null}
      </div>
      <div className="mt-3 space-y-3">
        {thread.comments.map((comment) => (
          <div key={comment.id}>
            <div className="flex gap-2 text-xs text-muted-foreground">
              <PullRequestActorLabel actor={comment.author} className="text-foreground" />
              <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
            </div>
            <div className="mt-1">
              <ChatMarkdown
                cwd={detail.workspaceRoot}
                text={toRenderablePullRequestMarkdown(comment.body)}
              />
            </div>
          </div>
        ))}
      </div>
      {canReply ? (
        <div className="mt-3">
          <Textarea
            aria-label={`Reply to ${thread.path}`}
            disabled={pending}
            placeholder="Reply to this thread"
            size="sm"
            value={reply}
            onChange={(event) => setReply(event.currentTarget.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && reply.trim()) {
                event.preventDefault();
                void onReply(thread.id, reply.trim())
                  .then(() => setReply(""))
                  .catch(() => undefined);
              }
            }}
          />
          <div className="mt-2 flex justify-end">
            <Button
              disabled={pending || reply.trim().length === 0}
              size="xs"
              onClick={() =>
                void onReply(thread.id, reply.trim())
                  .then(() => setReply(""))
                  .catch(() => undefined)
              }
            >
              Reply
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

type RenderablePullRequestPatch =
  | { readonly kind: "files"; readonly files: readonly FileDiffMetadata[] }
  | { readonly kind: "raw"; readonly text: string; readonly reason: string };

function renderPullRequestPatch(patch: string, cacheKey: string): RenderablePullRequestPatch {
  const normalized = patch.trim();
  if (!normalized) return { kind: "files", files: [] };
  try {
    const files = parsePatchFiles(normalized, cacheKey).flatMap((parsed) => parsed.files);
    return files.length > 0
      ? { kind: "files", files }
      : {
          kind: "raw",
          text: normalized,
          reason: "GitHub returned a diff format that could not be rendered.",
        };
  } catch {
    return {
      kind: "raw",
      text: normalized,
      reason: "This diff could not be parsed. Showing the raw patch.",
    };
  }
}

function pullRequestDiffPath(file: FileDiffMetadata): string {
  const path = file.name ?? file.prevName ?? "";
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

export function PullRequestCodeTab({
  detail,
  reference,
  environmentId,
  onReply,
  onResolve,
  pending,
}: {
  readonly detail: PullRequestDetailView;
  readonly reference: PullRequestRef;
  readonly environmentId: EnvironmentId;
  readonly onReply: (threadId: string, body: string) => Promise<void>;
  readonly onResolve: (threadId: string, resolved: boolean) => void;
  readonly pending: boolean;
}) {
  const diffQuery = useInfiniteQuery(
    pullRequestDiffInfiniteQueryOptions({ environmentId, request: reference }),
  );
  const [path, setPath] = useState("");
  const [line, setLine] = useState("1");
  const [side, setSide] = useState<PullRequestDiffSide>("right");
  const [body, setBody] = useState("");
  const key = pullRequestReviewKey(reference);
  const add = usePullRequestReviewStore((state) => state.add);
  const pendingReviewComments = usePullRequestReviewStore(
    (state) => state.commentsByKey[key] ?? EMPTY_PENDING_REVIEW_COMMENTS,
  );
  const { resolvedTheme } = useTheme();
  const pullRequestsCodeFontSize = useSettings((state) => state.pullRequestsCodeFontSize);
  const diffWordWrap = useSettings((state) => state.diffWordWrap);
  const parsedPatchCache = useRef(new Map<string, RenderablePullRequestPatch>());
  const diffTextStyle = useMemo<CSSProperties>(
    () =>
      ({
        "--diffs-font-size": `${pullRequestsCodeFontSize}px`,
        "--diffs-line-height": `${pullRequestsCodeFontSize + 8}px`,
      }) as CSSProperties,
    [pullRequestsCodeFontSize],
  );
  const diffOptions = useMemo(
    () => ({
      diffStyle: "unified" as const,
      lineDiffType: "none" as const,
      overflow: diffWordWrap ? ("wrap" as const) : ("scroll" as const),
      theme: resolveDiffThemeName(resolvedTheme),
      themeType: resolvedTheme,
    }),
    [diffWordWrap, resolvedTheme],
  );
  useEffect(() => {
    parsedPatchCache.current.clear();
  }, [key]);
  const renderablePages = useMemo(() => {
    return (diffQuery.data?.pages ?? []).map((page, index) => {
      const normalized = page.patch.trim();
      const cacheKey = buildPatchCacheKey(normalized, `${key}:${index}`);
      const cached = parsedPatchCache.current.get(cacheKey);
      if (cached !== undefined) {
        return {
          index,
          truncated: page.truncated,
          ...cached,
        };
      }
      const rendered = renderPullRequestPatch(normalized, cacheKey);
      parsedPatchCache.current.set(cacheKey, rendered);
      return {
        index,
        truncated: page.truncated,
        ...rendered,
      };
    });
  }, [diffQuery.data?.pages, key]);
  const files = useMemo(
    () =>
      renderablePages.flatMap((page) =>
        page.kind === "files"
          ? page.files.map((file, index) => ({
              file,
              index,
              pageIndex: page.index,
              path: pullRequestDiffPath(file),
            }))
          : [],
      ),
    [renderablePages],
  );
  const filePaths = useMemo(
    () => [...new Set(files.map((file) => file.path).filter((filePath) => filePath.length > 0))],
    [files],
  );
  const threadByPath = useMemo(
    () =>
      detail.reviewThreads.reduce<Record<string, PullRequestReviewThread[]>>((threads, thread) => {
        (threads[thread.path] ??= []).push(thread);
        return threads;
      }, {}),
    [detail.reviewThreads],
  );
  const canComment = detail.capabilities.review.inlineComment && detail.viewerPermissions.comment;
  const commentLine = Number(line);
  const isValidCommentLine = Number.isSafeInteger(commentLine) && commentLine > 0;

  if (diffQuery.isPending) {
    return <p className="p-4 text-sm text-muted-foreground">Loading diff…</p>;
  }
  if (diffQuery.error) {
    return (
      <div className="space-y-2 p-4 text-sm text-destructive">
        <p>{errorMessage(diffQuery.error)}</p>
        <Button size="xs" variant="outline" onClick={() => void diffQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-muted/10">
      <div className="sticky top-0 z-10 flex min-w-0 flex-wrap items-center gap-2 border-b border-border/60 bg-background/95 px-3 py-2 backdrop-blur">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium">
          <FileDiffIcon className="size-3.5 text-muted-foreground" />
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
          +{detail.additions}
        </span>
        <span className="font-mono text-[11px] text-red-600 dark:text-red-400">
          -{detail.deletions}
        </span>
        {diffQuery.hasNextPage ? (
          <span className="ml-auto text-[11px] text-muted-foreground">More files available</span>
        ) : null}
      </div>
      {files.length > 0 ? (
        <nav
          aria-label="Changed files"
          className="flex gap-1 overflow-x-auto border-b border-border/60 bg-background px-3 py-2"
        >
          {files.map(({ index, pageIndex, path: filePath }) => (
            <a
              className="max-w-52 shrink-0 truncate rounded-md border border-border/70 bg-muted/20 px-2 py-1 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              href={`#pull-request-file-${pageIndex}-${index}`}
              key={`${pageIndex}:${index}:${filePath}:link`}
              title={filePath}
            >
              {filePath}
            </a>
          ))}
        </nav>
      ) : null}
      <div className="space-y-3 p-3">
        {canComment ? (
          <section className="rounded-lg border border-border/70 bg-background p-3">
            <p className="text-sm font-medium">Add a line comment to this review</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_5rem_7rem]">
              <input
                aria-label="File path"
                className="h-8 rounded border border-input bg-background px-2 text-sm"
                list="pull-request-diff-paths"
                placeholder="src/file.ts"
                value={path}
                onChange={(event) => setPath(event.currentTarget.value)}
              />
              <input
                aria-label="Line number"
                className="h-8 rounded border border-input bg-background px-2 text-sm"
                inputMode="numeric"
                min="1"
                step="1"
                type="number"
                value={line}
                onChange={(event) => setLine(event.currentTarget.value)}
              />
              <select
                aria-label="Diff side"
                className="h-8 rounded border border-input bg-background px-2 text-sm"
                value={side}
                onChange={(event) => setSide(event.currentTarget.value as PullRequestDiffSide)}
              >
                <option value="right">New version</option>
                <option value="left">Old version</option>
              </select>
            </div>
            <datalist id="pull-request-diff-paths">
              {filePaths.map((filePath) => (
                <option key={filePath} value={filePath} />
              ))}
            </datalist>
            <Textarea
              className="mt-2"
              placeholder="Comment"
              size="sm"
              value={body}
              onChange={(event) => setBody(event.currentTarget.value)}
            />
            <div className="mt-2 flex justify-end">
              <Button
                disabled={
                  !path.trim() ||
                  !body.trim() ||
                  !isValidCommentLine ||
                  pendingReviewComments.length >= MAX_PULL_REQUEST_INLINE_REVIEW_COMMENTS
                }
                size="xs"
                onClick={() => {
                  add(key, {
                    id: nextPendingReviewCommentId(),
                    path: path.trim(),
                    line: commentLine,
                    side,
                    body: body.trim(),
                  });
                  setBody("");
                }}
              >
                Add to review
              </Button>
            </div>
          </section>
        ) : null}
        {files.length > 0 ? (
          <Virtualizer
            className="max-h-[calc(100dvh-23rem)] overflow-auto"
            config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
          >
            {files.map(({ file, index, pageIndex, path: filePath }) => (
              <section
                className="mb-3 overflow-hidden rounded-lg border border-border/70 last:mb-0"
                id={`pull-request-file-${pageIndex}-${index}`}
                key={`${pageIndex}:${index}:${filePath}`}
              >
                <FileDiff fileDiff={file} style={diffTextStyle} options={diffOptions} />
                {threadByPath[filePath]?.length ? (
                  <div className="space-y-2 border-t border-border/70 p-3">
                    {threadByPath[filePath].map((thread) => (
                      <ReviewThread
                        detail={detail}
                        key={thread.id}
                        pending={pending}
                        thread={thread}
                        onReply={onReply}
                        onResolve={onResolve}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            ))}
          </Virtualizer>
        ) : null}
        {renderablePages
          .filter((page) => page.kind === "raw")
          .map((page) => (
            <section
              className="overflow-hidden rounded-lg border border-border/70"
              key={`raw:${page.index}`}
            >
              <p className="border-b border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {page.reason}
              </p>
              <pre
                className={
                  diffWordWrap
                    ? "max-h-120 overflow-auto p-3 leading-5 whitespace-pre-wrap wrap-break-word"
                    : "max-h-120 overflow-auto p-3 leading-5"
                }
                style={{ fontSize: pullRequestsCodeFontSize }}
              >
                {page.text}
              </pre>
            </section>
          ))}
        {renderablePages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No diff available.</p>
        ) : null}
        {renderablePages.some((page) => page.truncated) ? (
          <p className="text-xs text-muted-foreground">
            Some files could not be rendered by GitHub.
          </p>
        ) : null}
        {diffQuery.hasNextPage ? (
          <div className="flex justify-center">
            <Button
              disabled={diffQuery.isFetchingNextPage}
              size="sm"
              variant="outline"
              onClick={() => void diffQuery.fetchNextPage()}
            >
              {diffQuery.isFetchingNextPage ? "Loading files…" : "Load more files"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
