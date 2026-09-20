import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestActivity,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestRef,
  PullRequestReviewVerdict,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLinkIcon,
  GitMergeIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  pullRequestActivityQueryOptions,
  pullRequestCommentMutationOptions,
  pullRequestDetailQueryOptions,
  pullRequestInvalidateMutationOptions,
  pullRequestReplyToThreadMutationOptions,
  pullRequestRequestReviewersMutationOptions,
  pullRequestReviewerCandidatesQueryOptions,
  pullRequestRunActionMutationOptions,
  pullRequestSetThreadResolutionMutationOptions,
  pullRequestSubmitReviewMutationOptions,
} from "~/lib/pullRequestReactQuery";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useOpenLink } from "~/browser/useOpenLink";
import { isWebUrl } from "~/browser/browserLinkTarget";
import { selectThreadShellsAcrossEnvironments, useStore } from "~/store";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { findPullRequestBrowserThread } from "~/lib/openPullRequestLink";

import {
  EMPTY_PENDING_REVIEW_COMMENTS,
  pullRequestReviewKey,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "./pullRequestReviewStore";
import {
  PullRequestActorLabel,
  PullRequestCheckStatusIcon,
  PullRequestDiffStat,
  PullRequestStateGlyph,
  pullRequestActionLabel,
  pullRequestCheckStatusLabel,
  pullRequestCheckSummaryLabel,
  pullRequestLabelColor,
  pullRequestReviewVerdictPresentation,
  resolvePullRequestMergeSelection,
  summarizePullRequestChecks,
  toRenderablePullRequestMarkdown,
} from "./pullRequestPresentation";

type DetailTab = "summary" | "timeline" | "code";
type PullRequestDetailView = PullRequestDetail & PullRequestActivity;

const TABS: readonly { readonly value: DetailTab; readonly label: string }[] = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
];

const LazyPullRequestCodeTab = lazy(() =>
  import("./PullRequestCodeTab").then(({ PullRequestCodeTab }) => ({
    default: PullRequestCodeTab,
  })),
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

/**
 * The verdict a submitted review carries. Delegates wording and tone to the
 * shared presentation helper so every surface reads a verdict the same way.
 */
function ReviewVerdictBadge({ reviewState }: { readonly reviewState: string | null }) {
  const presentation = pullRequestReviewVerdictPresentation(reviewState);
  if (presentation.variant === null) {
    return (
      <span className="rounded bg-accent px-1 py-px font-medium text-foreground">
        {presentation.label}
      </span>
    );
  }
  return (
    <Badge size="sm" variant={presentation.variant}>
      {presentation.label}
    </Badge>
  );
}

function isAvailableAction(detail: PullRequestDetailView, action: PullRequestAction): boolean {
  if (
    !detail.capabilities.actions.includes(action) ||
    !detail.viewerPermissions.actions.includes(action)
  ) {
    return false;
  }

  switch (action) {
    case "merge":
      return (
        detail.state === "open" &&
        !detail.isDraft &&
        detail.capabilities.mergeMethods.some((method) => detail.mergeCapabilities[method])
      );
    case "ready":
      return detail.state === "open" && detail.isDraft;
    case "draft":
      return detail.state === "open" && !detail.isDraft;
    case "close":
      return detail.state === "open";
    case "reopen":
      return detail.state === "closed";
  }
}

function toDetailView(
  detail: PullRequestDetail | undefined,
  activity: PullRequestActivity | undefined,
): PullRequestDetailView | null {
  if (!detail) return null;
  return {
    ...detail,
    ...(activity ?? {
      comments: [],
      commentCount: 0,
      commentsTruncated: false,
      reviewThreads: [],
      commits: [],
    }),
    author: activity?.author ?? detail.author,
    reviewers: activity?.reviewers ?? detail.reviewers,
  };
}

function CommentComposer({
  value,
  disabled,
  onChange,
  onSubmit,
}: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <section>
      <h2 className="text-sm font-medium">Comment</h2>
      <Textarea
        className="mt-2"
        placeholder="Leave a comment"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && value.trim()) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="mt-2 flex justify-end">
        <Button disabled={disabled || !value.trim()} size="xs" onClick={onSubmit}>
          Comment
        </Button>
      </div>
    </section>
  );
}

function ReviewComposer({
  detail,
  reference,
  submitting,
  onSubmit,
}: {
  readonly detail: PullRequestDetailView;
  readonly reference: PullRequestRef;
  readonly submitting: boolean;
  readonly onSubmit: (input: {
    readonly verdict: PullRequestReviewVerdict;
    readonly body: string;
    readonly comments: readonly PendingReviewComment[];
  }) => void;
}) {
  const key = pullRequestReviewKey(reference);
  const comments = usePullRequestReviewStore(
    (state) => state.commentsByKey[key] ?? EMPTY_PENDING_REVIEW_COMMENTS,
  );
  const summary = usePullRequestReviewStore((state) => state.summariesByKey[key] ?? "");
  const remove = usePullRequestReviewStore((state) => state.remove);
  const setSummary = usePullRequestReviewStore((state) => state.setSummary);
  const canSubmit = detail.capabilities.review.verdicts.some((verdict) =>
    detail.viewerPermissions.verdicts.includes(verdict),
  );

  if (!canSubmit) return null;
  const hasContent = summary.trim().length > 0 || comments.length > 0;
  const submit = (verdict: PullRequestReviewVerdict) =>
    onSubmit({
      verdict,
      body: summary,
      comments,
    });

  return (
    <section className="rounded-lg border border-border/70 bg-card p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <MessageSquareIcon className="size-4" />
        Review
        {comments.length > 0 ? (
          <span className="text-xs font-normal text-muted-foreground">
            {comments.length} pending line {comments.length === 1 ? "comment" : "comments"}
          </span>
        ) : null}
      </div>
      {comments.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {comments.map((comment) => (
            <li className="flex gap-2" key={comment.id}>
              <span className="min-w-0 flex-1 truncate">
                {comment.path}:{comment.line} — {comment.body}
              </span>
              <button
                aria-label={`Discard comment at ${comment.path}:${comment.line}`}
                className="text-destructive hover:underline"
                type="button"
                onClick={() => remove(key, comment.id)}
              >
                Discard
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Textarea
        className="mt-3"
        disabled={submitting}
        placeholder="Leave a review summary"
        value={summary}
        onChange={(event) => setSummary(key, event.currentTarget.value)}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {detail.capabilities.review.verdicts
          .filter((verdict) => detail.viewerPermissions.verdicts.includes(verdict))
          .map((verdict) => (
            <Button
              disabled={submitting || (verdict !== "approve" && !hasContent)}
              key={verdict}
              size="xs"
              variant={verdict === "request-changes" ? "destructive" : "outline"}
              onClick={() => submit(verdict)}
            >
              {verdict === "approve"
                ? "Approve"
                : verdict === "request-changes"
                  ? "Request changes"
                  : "Comment"}
            </Button>
          ))}
      </div>
    </section>
  );
}

export function PullRequestDetailPanel({
  environmentId,
  reference,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DetailTab>("summary");
  const detailQuery = useQuery(pullRequestDetailQueryOptions({ environmentId, reference }));
  const activityQuery = useQuery({
    ...pullRequestActivityQueryOptions({
      environmentId,
      reference,
      enabled: tab !== "summary",
    }),
    refetchInterval: tab === "timeline" ? 30_000 : false,
  });
  const [comment, setComment] = useState("");
  const [actionPending, setActionPending] = useState<PullRequestAction | null>(null);
  const [mergeMethodOverride, setMergeMethodOverride] = useState<PullRequestMergeMethod | null>(
    null,
  );
  const detail = toDetailView(detailQuery.data, activityQuery.data);
  const owner = useStore((state) =>
    findPullRequestBrowserThread(
      selectThreadShellsAcrossEnvironments(state),
      environmentId,
      reference,
    ),
  );
  const browserThreadRef = useMemo(
    () => (owner ? scopeThreadRef(owner.environmentId, owner.id) : null),
    [owner?.environmentId, owner?.id],
  );
  const openLink = useOpenLink(browserThreadRef, true);
  const runAction = useMutation(
    pullRequestRunActionMutationOptions({ environmentId, queryClient }),
  );
  const postComment = useMutation(
    pullRequestCommentMutationOptions({ environmentId, queryClient }),
  );
  const submitReview = useMutation(
    pullRequestSubmitReviewMutationOptions({ environmentId, queryClient }),
  );
  const reply = useMutation(
    pullRequestReplyToThreadMutationOptions({ environmentId, queryClient }),
  );
  const resolve = useMutation(
    pullRequestSetThreadResolutionMutationOptions({ environmentId, queryClient }),
  );
  const invalidate = useMutation(
    pullRequestInvalidateMutationOptions({ environmentId, queryClient }),
  );
  const reviewersQuery = useQuery(
    pullRequestReviewerCandidatesQueryOptions({
      environmentId,
      reference,
      enabled: detail?.capabilities.reviewers.listCandidates === true,
    }),
  );
  const requestReviewers = useMutation(
    pullRequestRequestReviewersMutationOptions({ environmentId, queryClient }),
  );

  const refresh = () => {
    void invalidate.mutateAsync({ reference }).catch((error) =>
      toastManager.add({
        type: "error",
        title: "Could not refresh",
        description: errorMessage(error),
      }),
    );
  };
  const performAction = async (
    action: PullRequestAction,
    input?: { mergeMethod?: PullRequestMergeMethod },
  ) => {
    if (!detail || actionPending) return;
    if (
      action === "close" &&
      typeof window !== "undefined" &&
      !window.confirm(`Close PR #${detail.number} "${detail.title}"?`)
    ) {
      return;
    }
    setActionPending(action);
    try {
      const mergeMethod =
        action === "merge"
          ? (input?.mergeMethod ??
            detail.capabilities.mergeMethods.find((method) => detail.mergeCapabilities[method]) ??
            undefined)
          : undefined;
      await runAction.mutateAsync({
        ...reference,
        action,
        ...(mergeMethod ? { mergeMethod } : {}),
      });
      const successLabels: Record<PullRequestAction, string> = {
        close: "Pull request closed",
        draft: "Pull request converted to draft",
        merge: "Pull request merged",
        ready: "Pull request marked ready",
        reopen: "Pull request reopened",
      };
      toastManager.add({ type: "success", title: successLabels[action] });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Pull request action failed",
        description: errorMessage(error),
      });
    } finally {
      setActionPending(null);
    }
  };
  const sendReply = async (threadId: string, body: string) => {
    try {
      await reply.mutateAsync({ ...reference, threadId, body });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not reply",
        description: errorMessage(error),
      });
      throw error;
    }
  };
  const toggleResolved = (threadId: string, resolved: boolean) => {
    void resolve.mutateAsync({ ...reference, threadId, resolved }).catch((error) =>
      toastManager.add({
        type: "error",
        title: "Could not update thread",
        description: errorMessage(error),
      }),
    );
  };
  const submitComment = () => {
    const submittedComment = comment.trim();
    if (postComment.isPending || !submittedComment) return;
    void postComment
      .mutateAsync({ ...reference, body: submittedComment })
      .then(() => setComment((current) => (current === submittedComment ? "" : current)))
      .catch((error) =>
        toastManager.add({
          type: "error",
          title: "Could not post comment",
          description: errorMessage(error),
        }),
      );
  };
  const timelineItems = useMemo(
    () =>
      [
        ...(detail?.comments ?? []).map((comment) => ({ kind: "comment" as const, item: comment })),
        ...(detail?.commits ?? []).map((commit) => ({ kind: "commit" as const, item: commit })),
      ].toSorted((left, right) => {
        const leftDate = left.kind === "comment" ? left.item.createdAt : left.item.committedDate;
        const rightDate =
          right.kind === "comment" ? right.item.createdAt : right.item.committedDate;
        return leftDate.localeCompare(rightDate);
      }),
    [detail?.comments, detail?.commits],
  );

  if (detailQuery.isPending) {
    return (
      <div className="flex h-full flex-col gap-4 p-4" aria-busy="true">
        <div className="flex items-start gap-3">
          <div className="size-5 animate-pulse rounded-full bg-muted" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
            <div className="h-3 w-2/5 animate-pulse rounded bg-muted" />
          </div>
        </div>
        <div className="h-8 animate-pulse rounded bg-muted/70" />
        <div className="h-24 animate-pulse rounded-lg bg-muted/50" />
      </div>
    );
  }
  if (detailQuery.error || !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-destructive">{errorMessage(detailQuery.error)}</p>
        <Button size="sm" variant="outline" onClick={() => void detailQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const availableActions = detail.capabilities.actions.filter((action) =>
    isAvailableAction(detail, action),
  );
  // Merge strategies the host allows for this pull request. The choice is
  // the reviewer's, not the first allowed method's: squash and merge land
  // very different history.
  const { allowedMergeMethods, selectedMergeMethod, showMergeMethodPicker } =
    resolvePullRequestMergeSelection({
      canMerge: availableActions.includes("merge"),
      mergeMethods: detail.capabilities.mergeMethods,
      mergeCapabilities: detail.mergeCapabilities,
      override: mergeMethodOverride,
    });
  const checkSummary = summarizePullRequestChecks(detail.checks);
  const checkIndicatorClassName =
    checkSummary.failing > 0 || checkSummary.cancelled > 0
      ? "text-destructive"
      : checkSummary.pending > 0
        ? "text-muted-foreground"
        : "text-emerald-500";
  const timelineCount = timelineItems.length;
  const tabs = detail.capabilities.diff ? TABS : TABS.filter((tab) => tab.value !== "code");
  const activeTab = tabs.some((item) => item.value === tab) ? tab : "summary";
  const reviewKey = pullRequestReviewKey(reference);

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      onClickCapture={(event) => {
        if (event.button !== 0 || !(event.target instanceof Element)) return;
        const link = event.target.closest("a[href]");
        const url = link?.getAttribute("href");
        if (!url || !isWebUrl(url)) return;
        event.preventDefault();
        event.stopPropagation();
        void openLink(url, { event }).catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not open link",
            description: errorMessage(error),
          });
        });
      }}
    >
      <header className="shrink-0 border-b border-border bg-background px-4 pt-4">
        <div className="flex items-start gap-2">
          <PullRequestStateGlyph
            isDraft={detail.isDraft}
            mergeability={detail.mergeability}
            state={detail.state}
          />
          <h1
            className="min-w-0 flex-1 text-base leading-5 font-semibold"
            title={`#${detail.number} ${detail.title}`}
          >
            #{detail.number} {detail.title}
          </h1>
          <Button
            aria-label="Refresh pull request"
            size="icon-xs"
            variant="ghost"
            onClick={refresh}
          >
            <RefreshCwIcon className={cn("size-3.5", invalidate.isPending && "animate-spin")} />
          </Button>
          <Button
            aria-label="Close pull request panel"
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
        <div className="mt-1 pl-7 text-xs text-muted-foreground">
          Opened by <PullRequestActorLabel actor={detail.author} className="inline-flex" /> ·
          Updated {formatRelativeTimeLabel(detail.updatedAt)}
          {detail.isDraft ? " · Draft" : ""}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 pl-7 text-xs text-muted-foreground">
          <span
            className="inline-flex max-w-56 items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-mono"
            title={`Head branch: ${detail.headBranch}`}
          >
            <span className="truncate">{detail.headBranch}</span>
          </span>
          <span aria-hidden>→</span>
          <span
            className="inline-flex max-w-40 items-center rounded bg-muted/60 px-1.5 py-0.5 font-mono"
            title={`Base branch: ${detail.baseBranch}`}
          >
            <span className="truncate">{detail.baseBranch}</span>
          </span>
          <PullRequestDiffStat additions={detail.additions} deletions={detail.deletions} />
          <span
            className="inline-flex items-center gap-1"
            title={pullRequestCheckSummaryLabel(checkSummary)}
          >
            {detail.checks.length > 0 ? <span className={checkIndicatorClassName}>●</span> : null}
            {detail.checks.length > 0
              ? `${checkSummary.passing}/${detail.checks.length} checks`
              : "No checks"}
          </span>
          <a
            className="inline-flex items-center gap-1 hover:text-foreground"
            href={detail.url}
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
              event.preventDefault();
              void openLink(detail.url).catch((error: unknown) => {
                toastManager.add({
                  type: "error",
                  title: "Could not open pull request",
                  description: errorMessage(error),
                });
              });
            }}
          >
            GitHub <ExternalLinkIcon className="size-3" />
          </a>
        </div>
        {availableActions.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1">
            {availableActions
              .filter((action) => action !== "close")
              .map((action) => (
                <span className="inline-flex items-center gap-1" key={action}>
                  {action === "merge" && showMergeMethodPicker && selectedMergeMethod ? (
                    <select
                      aria-label="Merge method"
                      className="h-6 rounded border border-input bg-background px-1 text-xs"
                      disabled={actionPending !== null}
                      value={selectedMergeMethod}
                      onChange={(event) =>
                        setMergeMethodOverride(event.currentTarget.value as PullRequestMergeMethod)
                      }
                    >
                      {allowedMergeMethods.map((method) => (
                        <option key={method} value={method}>
                          {method === "merge" ? "Merge" : method === "squash" ? "Squash" : "Rebase"}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <Button
                    aria-label={pullRequestActionLabel(action)}
                    disabled={actionPending !== null}
                    size="xs"
                    title={
                      action === "merge"
                        ? `Merge ${detail.headBranch} into ${detail.baseBranch}${
                            selectedMergeMethod ? ` via ${selectedMergeMethod}` : ""
                          }`
                        : pullRequestActionLabel(action)
                    }
                    variant={action === "merge" ? "default" : "outline"}
                    onClick={() =>
                      void performAction(
                        action,
                        action === "merge" && selectedMergeMethod
                          ? { mergeMethod: selectedMergeMethod }
                          : undefined,
                      )
                    }
                  >
                    {actionPending === action ? (
                      "Working…"
                    ) : action === "merge" ? (
                      <>
                        <GitMergeIcon className="size-3" />
                        Merge
                      </>
                    ) : (
                      pullRequestActionLabel(action)
                    )}
                  </Button>
                </span>
              ))}
            {availableActions.includes("close") ? (
              <Button
                aria-label="Close pull request"
                className="ml-auto"
                disabled={actionPending !== null}
                size="xs"
                title="Close this pull request without merging"
                variant="destructive"
                onClick={() => void performAction("close")}
              >
                {actionPending === "close" ? "Working…" : "Close"}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div
          aria-label="Pull request detail tabs"
          className="-mx-4 mt-4 flex gap-1 border-t border-border/70 px-4 py-2"
          role="tablist"
        >
          {tabs.map((item) => {
            const count =
              item.value === "timeline"
                ? timelineCount
                : item.value === "code"
                  ? detail.commits.length
                  : null;
            const selected = activeTab === item.value;
            return (
              <button
                aria-controls={selected ? "pr-panel" : undefined}
                aria-selected={selected}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium tabular-nums transition-colors",
                  selected
                    ? "border-border bg-accent text-foreground shadow-xs/5"
                    : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-accent/60 hover:text-foreground",
                )}
                id={`pr-tab-${item.value}`}
                key={item.value}
                role="tab"
                type="button"
                onClick={() => setTab(item.value)}
              >
                {item.label}
                {count !== null && count > 0 ? (
                  <span className="ml-1 text-muted-foreground">({count})</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </header>
      <div
        aria-labelledby={`pr-tab-${activeTab}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        id="pr-panel"
        role="tabpanel"
      >
        {activeTab === "summary" ? (
          <div className="space-y-5 p-4">
            <ChatMarkdown
              cwd={detail.workspaceRoot}
              text={toRenderablePullRequestMarkdown(detail.body || "_No description provided._")}
            />
            {detail.labels.length > 0 ? (
              <section>
                <h2 className="text-sm font-medium">Labels</h2>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {detail.labels.map((label) => {
                    const dot = pullRequestLabelColor(label.color);
                    return (
                      <span
                        className="inline-flex max-w-40 min-w-0 items-center gap-1 rounded-full border border-border/70 bg-muted/40 py-0 pr-1.5 pl-1 text-[10px] leading-3.5 text-muted-foreground"
                        key={label.name}
                      >
                        <span
                          aria-hidden
                          className="size-2 shrink-0 rounded-full bg-muted-foreground"
                          {...(dot ? { style: { backgroundColor: dot } } : {})}
                        />
                        <span className="truncate">{label.name}</span>
                      </span>
                    );
                  })}
                </div>
              </section>
            ) : null}
            <section>
              <h2 className="text-sm font-medium">Checks</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {detail.checks.map((check) => (
                  <li className="flex items-center gap-2" key={check.name}>
                    <PullRequestCheckStatusIcon status={check.status} />
                    {check.url ? (
                      <a
                        className="hover:underline"
                        href={check.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {check.name}
                      </a>
                    ) : (
                      check.name
                    )}
                    <span className="text-xs text-muted-foreground">
                      {pullRequestCheckStatusLabel(check.status)}
                    </span>
                  </li>
                ))}
                {detail.checks.length === 0 ? (
                  <li className="text-sm text-muted-foreground">No checks reported.</li>
                ) : null}
              </ul>
            </section>
            {detail.reviewers.length > 0 || detail.capabilities.reviewers.listCandidates ? (
              <section>
                <h2 className="text-sm font-medium">Reviewers</h2>
                <div className="mt-2 flex flex-wrap gap-2">
                  {detail.reviewers.map((reviewer) => (
                    <span
                      className="inline-flex items-center rounded border border-border/70 px-2 py-1 text-xs"
                      key={reviewer.login}
                    >
                      <PullRequestActorLabel actor={reviewer} />
                    </span>
                  ))}
                  {reviewersQuery.data?.candidates.map((candidate) => (
                    <Button
                      disabled={
                        !detail.capabilities.reviewers.request ||
                        !detail.viewerPermissions.requestReviewers ||
                        requestReviewers.isPending
                      }
                      key={`${candidate.kind}:${candidate.id}`}
                      size="xs"
                      variant={candidate.isRequested ? "secondary" : "outline"}
                      onClick={() =>
                        void requestReviewers
                          .mutateAsync({
                            ...reference,
                            requested: !candidate.isRequested,
                            reviewers: [{ id: candidate.id, kind: candidate.kind }],
                          })
                          .catch((error) =>
                            toastManager.add({
                              type: "error",
                              title: "Could not update reviewer",
                              description: errorMessage(error),
                            }),
                          )
                      }
                    >
                      {candidate.isRequested ? "Requested: " : "Request: "}
                      {candidate.login}
                    </Button>
                  ))}
                  {reviewersQuery.isPending ? (
                    <span className="text-xs text-muted-foreground">Loading reviewers…</span>
                  ) : null}
                  {reviewersQuery.error ? (
                    <span className="text-xs text-destructive">
                      Could not load reviewer suggestions.
                    </span>
                  ) : null}
                </div>
              </section>
            ) : null}
            {detail.capabilities.comment && detail.viewerPermissions.comment ? (
              <CommentComposer
                value={comment}
                disabled={postComment.isPending}
                onChange={setComment}
                onSubmit={submitComment}
              />
            ) : null}
          </div>
        ) : null}
        {activeTab === "timeline" ? (
          <div className="space-y-4 p-4">
            {activityQuery.isPending ? (
              <p className="text-sm text-muted-foreground">Loading timeline…</p>
            ) : null}
            {activityQuery.error ? (
              <div className="flex items-center gap-3 rounded border border-destructive/40 p-3 text-sm text-destructive">
                <span className="min-w-0 flex-1">
                  Could not load the full timeline: {errorMessage(activityQuery.error)}
                </span>
                <Button size="xs" variant="outline" onClick={() => void activityQuery.refetch()}>
                  Retry
                </Button>
              </div>
            ) : null}
            {timelineItems.map((entry) =>
              entry.kind === "commit" ? (
                <article className="border-b border-border/60 pb-4" key={entry.item.oid}>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="font-mono text-foreground">{entry.item.oid.slice(0, 7)}</span>
                    <span>committed</span>
                    <span>{formatRelativeTimeLabel(entry.item.committedDate)}</span>
                  </div>
                  <p className="mt-2 text-sm">{entry.item.messageHeadline}</p>
                </article>
              ) : (
                <article className="border-b border-border/60 pb-4" key={entry.item.id}>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <PullRequestActorLabel actor={entry.item.author} className="text-foreground" />
                    <span>{formatRelativeTimeLabel(entry.item.createdAt)}</span>
                    {entry.item.kind === "review-comment" && entry.item.path ? (
                      <span className="min-w-0 truncate font-mono text-[11px]">
                        {entry.item.path}
                        {typeof entry.item.reviewState === "string" && entry.item.reviewState
                          ? ` · ${entry.item.reviewState}`
                          : ""}
                      </span>
                    ) : null}
                    {entry.item.kind === "review" ? (
                      <ReviewVerdictBadge reviewState={entry.item.reviewState} />
                    ) : null}
                  </div>
                  <div className="mt-2 text-sm">
                    <ChatMarkdown
                      cwd={detail.workspaceRoot}
                      text={toRenderablePullRequestMarkdown(entry.item.body)}
                    />
                  </div>
                </article>
              ),
            )}
            {detail.commentsTruncated ? (
              <p className="text-xs text-muted-foreground">
                GitHub returned the most recent {detail.comments.length} of {detail.commentCount}{" "}
                items; some line-level review comments may be missing.
              </p>
            ) : null}
            {timelineItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No conversation yet.</p>
            ) : null}
            {detail.capabilities.comment && detail.viewerPermissions.comment ? (
              <div className="sticky bottom-0 -mx-4 border-t border-border bg-background px-4 pt-3 pb-4">
                <CommentComposer
                  value={comment}
                  disabled={postComment.isPending}
                  onChange={setComment}
                  onSubmit={submitComment}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {activeTab === "code" ? (
          <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading code…</p>}>
            <LazyPullRequestCodeTab
              detail={detail}
              environmentId={environmentId}
              key={reviewKey}
              reference={reference}
              onReply={sendReply}
              onResolve={toggleResolved}
              pending={reply.isPending || resolve.isPending}
            />
          </Suspense>
        ) : null}
        {activeTab !== "summary" ? (
          <div className="p-4 pt-0">
            <ReviewComposer
              detail={detail}
              reference={reference}
              submitting={submitReview.isPending}
              onSubmit={({ verdict, body, comments }) =>
                void submitReview
                  .mutateAsync({
                    ...reference,
                    verdict,
                    body,
                    comments: comments.map(({ id: _id, ...comment }) => comment),
                  })
                  .then(() => {
                    usePullRequestReviewStore.getState().removeSubmitted(
                      reviewKey,
                      comments.map((comment) => comment.id),
                    );
                    usePullRequestReviewStore.getState().clearSubmitted(reviewKey, body);
                    toastManager.add({ type: "success", title: "Review submitted" });
                  })
                  .catch((error) =>
                    toastManager.add({
                      type: "error",
                      title: "Could not submit review",
                      description: errorMessage(error),
                    }),
                  )
              }
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
