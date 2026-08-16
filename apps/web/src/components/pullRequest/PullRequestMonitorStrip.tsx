import type {
  EnvironmentId,
  PullRequestMonitorFeedbackItem,
  PullRequestMonitorRecord,
  PullRequestRef,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIcon,
  LifeBuoyIcon,
  PauseIcon,
  PlayIcon,
  RadarIcon,
  UserRoundIcon,
} from "lucide-react";
import { useMemo } from "react";

import {
  pullRequestMonitorLaunchFallbackMutationOptions,
  pullRequestMonitorStartMutationOptions,
  pullRequestMonitorStatusQueryOptions,
  pullRequestMonitorStopMutationOptions,
} from "~/lib/pullRequestReactQuery";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

function statusLabel(monitor: PullRequestMonitorRecord | null | undefined): string {
  if (!monitor || !monitor.enabled) return "Not monitoring";
  switch (monitor.status) {
    case "monitoring":
      return "Monitoring";
    case "ready":
      return monitor.readiness?.label === "ready-to-merge" ? "Ready to merge" : "No known blockers";
    case "terminal":
      return "Closed or merged";
    case "error":
      return "Monitor error";
    case "stopped":
      return "Stopped";
    default:
      return monitor.status;
  }
}

function blockersSummary(monitor: PullRequestMonitorRecord | null | undefined): string | null {
  const blockers = monitor?.readiness?.blockers ?? [];
  if (blockers.length === 0) return null;
  return blockers
    .slice(0, 4)
    .map((blocker) => (blocker.detail ? `${blocker.kind}: ${blocker.detail}` : blocker.kind))
    .join(" · ");
}

/**
 * Observe-only control strip plus feedback audit. Monitoring is server-owned;
 * this UI only starts/stops/status and surfaces durable feedback/delivery state.
 */
export function PullRequestMonitorStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const statusQuery = useQuery(
    pullRequestMonitorStatusQueryOptions({
      environmentId: props.environmentId,
      reference: props.reference,
    }),
  );
  const start = useMutation(
    pullRequestMonitorStartMutationOptions({
      environmentId: props.environmentId,
      queryClient,
    }),
  );
  const stop = useMutation(
    pullRequestMonitorStopMutationOptions({
      environmentId: props.environmentId,
      queryClient,
    }),
  );
  const launchFallback = useMutation(
    pullRequestMonitorLaunchFallbackMutationOptions({
      environmentId: props.environmentId,
      queryClient,
    }),
  );

  const monitor = statusQuery.data?.monitor ?? null;
  const openFeedback = statusQuery.data?.openFeedback ?? [];
  const recentDeliveries = statusQuery.data?.recentDeliveries ?? [];
  const recentReports = statusQuery.data?.recentReports ?? [];
  const active = monitor?.enabled === true;
  const showFallback = active && monitor?.ownerThreadId === null;
  // Exactly one chat may modify a monitored PR; make that owner visible.
  const ownership = useMemo(() => {
    if (!monitor) return null;
    const owner = monitor.ownerThreadId ? `Owner chat ${monitor.ownerThreadId}` : "No owner chat";
    const review = monitor.linkedReviewThreadId
      ? ` · Review chat ${monitor.linkedReviewThreadId}`
      : "";
    return `${owner}${review}`;
  }, [monitor]);
  const summary = useMemo(() => blockersSummary(monitor), [monitor]);
  const feedbackSummary = useMemo(() => {
    if (openFeedback.length === 0) return null;
    return openFeedback
      .slice(0, 3)
      .map(
        (item: PullRequestMonitorFeedbackItem) =>
          `${item.kind}${item.disposition ? ` (${item.disposition})` : ""}`,
      )
      .join(" · ");
  }, [openFeedback]);
  const deliverySummary = useMemo(() => {
    const latest = recentDeliveries[0];
    if (!latest) return null;
    return `Last delivery: ${latest.status}${latest.lastError ? ` — ${latest.lastError}` : ""}`;
  }, [recentDeliveries]);

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2",
        props.className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <RadarIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{statusLabel(monitor)}</div>
          {summary ? (
            <div className="truncate text-xs text-muted-foreground">{summary}</div>
          ) : monitor?.lastError ? (
            <div className="truncate text-xs text-destructive">{monitor.lastError}</div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Server-owned observe loop. Merge stays human-controlled.
            </div>
          )}
        </div>
        {active ? (
          <Button
            size="sm"
            variant="outline"
            disabled={stop.isPending}
            onClick={() => {
              void stop
                .mutateAsync({ reference: props.reference })
                .then(() => {
                  toastManager.add({ type: "success", title: "Monitoring stopped" });
                })
                .catch((error: unknown) => {
                  toastManager.add({
                    type: "error",
                    title: "Could not stop monitoring",
                    description: error instanceof Error ? error.message : String(error),
                  });
                });
            }}
          >
            <PauseIcon className="size-3.5" />
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={start.isPending}
            onClick={() => {
              void start
                .mutateAsync({
                  projectId: props.reference.projectId,
                  repository: props.reference.repository,
                  number: props.reference.number,
                })
                .then(() => {
                  toastManager.add({ type: "success", title: "Monitoring started" });
                })
                .catch((error: unknown) => {
                  toastManager.add({
                    type: "error",
                    title: "Could not start monitoring",
                    description: error instanceof Error ? error.message : String(error),
                  });
                });
            }}
          >
            <PlayIcon className="size-3.5" />
            Monitor
          </Button>
        )}
        {showFallback ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={launchFallback.isPending}
            onClick={() => {
              void launchFallback
                .mutateAsync({
                  reference: props.reference,
                  reason: "owner-missing",
                })
                .then((result) => {
                  toastManager.add({
                    type: "success",
                    title: result.launched
                      ? "Fallback maintenance thread launched"
                      : "Fallback not launched",
                    description: result.skippedReason ?? undefined,
                  });
                })
                .catch((error: unknown) => {
                  toastManager.add({
                    type: "error",
                    title: "Fallback launch failed",
                    description: error instanceof Error ? error.message : String(error),
                  });
                });
            }}
          >
            <LifeBuoyIcon className="size-3.5" />
            Fallback
          </Button>
        ) : null}
      </div>
      {ownership ? (
        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <UserRoundIcon className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 truncate">{ownership}</span>
        </div>
      ) : null}
      {feedbackSummary || deliverySummary || recentReports.length > 0 ? (
        <div className="flex flex-col gap-0.5 border-t border-border/40 pt-2 text-xs text-muted-foreground">
          {feedbackSummary ? (
            <div className="flex items-start gap-1.5">
              <ActivityIcon className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 truncate">Open feedback: {feedbackSummary}</span>
            </div>
          ) : null}
          {deliverySummary ? <div className="truncate pl-4">{deliverySummary}</div> : null}
          {recentReports[0] ? (
            <div className="truncate pl-4">
              Last report: {recentReports[0].disposition}
              {recentReports[0].note ? ` — ${recentReports[0].note}` : ""}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
