import type { GitPullRequestAssociation, ThreadPullRequestLink } from "@t3tools/contracts";
import { LinkIcon, PlusIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

interface ThreadPullRequestsPanelProps {
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly enabled: boolean;
  readonly onLink: (reference: string) => Promise<void>;
  readonly onUnlink: (pullRequest: GitPullRequestAssociation) => Promise<void>;
}

export function ThreadPullRequestsPanel({
  pullRequests,
  enabled,
  onLink,
  onUnlink,
}: ThreadPullRequestsPanelProps) {
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);

  if (!enabled && pullRequests.length < 2) {
    return null;
  }

  const submit = async () => {
    const value = reference.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onLink(value);
      setReference("");
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to link pull request",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  const unlink = async (pullRequest: GitPullRequestAssociation) => {
    try {
      await onUnlink(pullRequest);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to unlink pull request",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  const states = new Set(pullRequests.map((link) => link.pullRequest.state));
  const stateLabel =
    states.size === 0 ? "none" : states.size === 1 ? ([...states][0] ?? "unknown") : "mixed";

  return (
    <details className="relative shrink-0">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md border border-transparent px-2 py-1 text-xs hover:border-input hover:bg-muted">
        <LinkIcon className="size-3" />
        PRs
        <Badge variant="secondary" className="px-1.5 text-[10px]">
          {pullRequests.length} {stateLabel}
        </Badge>
      </summary>
      <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-md border bg-popover p-3 text-popover-foreground shadow-lg">
        <div className="mb-2 text-xs font-medium">Linked pull requests</div>
        <div className="space-y-2">
          {pullRequests.length === 0 ? (
            <div className="text-xs text-muted-foreground">No pull requests linked.</div>
          ) : (
            pullRequests.map((link) => (
              <div
                key={`${link.pullRequest.url}-${link.pullRequest.number}`}
                className="flex items-center gap-2 text-xs"
              >
                <a
                  className="min-w-0 flex-1 truncate hover:underline"
                  href={link.pullRequest.url}
                  target="_blank"
                  rel="noreferrer"
                  title={link.pullRequest.title}
                >
                  #{link.pullRequest.number} {link.pullRequest.title}
                </a>
                {enabled ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Unlink pull request #${link.pullRequest.number}`}
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void unlink(link.pullRequest);
                    }}
                  >
                    <UnlinkIcon className="size-3" />
                  </Button>
                ) : null}
              </div>
            ))
          )}
        </div>
        {enabled ? (
          <form
            className="mt-3 flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <input
              className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
              placeholder="PR URL or number"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              disabled={busy}
            />
            <Button
              type="submit"
              size="icon-xs"
              variant="outline"
              aria-label="Link pull request"
              disabled={busy || !reference.trim()}
            >
              <PlusIcon className="size-3" />
            </Button>
          </form>
        ) : null}
      </div>
    </details>
  );
}
