import type { EnvironmentId, PullRequestMonitorRecord, PullRequestRef } from "@t3tools/contracts";
import { ActivityIcon, LifeBuoyIcon, PauseIcon, PlayIcon, RadarIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
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
  const statusQuery = useEnvironmentQuery(
    pullRequestEnvironment.monitorsStatus({
      environmentId: props.environmentId,
      input: { reference: props.reference },
    }),
  );
  const start = useAtomCommand(pullRequestEnvironment.monitorsStart, { reportFailure: false });
  const stop = useAtomCommand(pullRequestEnvironment.monitorsStop, { reportFailure: false });
  const launchFallback = useAtomCommand(pullRequestEnvironment.monitorsLaunchFallback, {
    reportFailure: false,
  });

  const monitor = statusQuery.data?.monitor ?? null;
  const openFeedback = statusQuery.data?.openFeedback ?? [];
  const recentDeliveries = statusQuery.data?.recentDeliveries ?? [];
  const recentReports = statusQuery.data?.recentReports ?? [];
  const active = monitor?.enabled === true;
  const showFallback = active && monitor?.ownerThreadId === null;
  const summary = useMemo(() => blockersSummary(monitor), [monitor]);
  const feedbackSummary = useMemo(() => {
    if (openFeedback.length === 0) return null;
    return openFeedback
      .slice(0, 3)
      .map((item) => `${item.kind}${item.disposition ? ` (${item.disposition})` : ""}`)
      .join(" · ");
  }, [openFeedback]);
  const deliverySummary = useMemo(() => {
    const latest = recentDeliveries[0];
    if (!latest) return null;
    return `Last delivery: ${latest.status}${latest.lastError ? ` — ${latest.lastError}` : ""}`;
  }, [recentDeliveries]);
  const reportSummary = useMemo(() => {
    const latest = recentReports[0];
    if (!latest) return null;
    return `Last report: ${latest.disposition}${latest.note ? ` — ${latest.note}` : ""}`;
  }, [recentReports]);

  const onStart = useCallback(async () => {
    try {
      await start({
        environmentId: props.environmentId,
        input: { ...props.reference },
      });
      statusQuery.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start monitoring",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [props.environmentId, props.reference, start, statusQuery]);

  const onStop = useCallback(async () => {
    try {
      await stop({
        environmentId: props.environmentId,
        input: monitor ? { monitorId: monitor.id } : { reference: props.reference },
      });
      statusQuery.refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not stop monitoring",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [monitor, props.environmentId, props.reference, statusQuery, stop]);

  const onFallback = useCallback(async () => {
    try {
      const result = await launchFallback({
        environmentId: props.environmentId,
        input: monitor
          ? { monitorId: monitor.id, reason: "owner-missing" }
          : { reference: props.reference, reason: "owner-missing" },
      });
      statusQuery.refresh();
      toastManager.add({
        type: "success",
        title: result.launched ? "Fallback maintenance thread launched" : "Fallback not needed",
        description: result.launched
          ? `Owner transferred to ${result.fallbackThreadId}`
          : (result.skippedReason ?? "No launch"),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not launch fallback maintenance",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [launchFallback, monitor, props.environmentId, props.reference, statusQuery]);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs",
        props.className,
      )}
    >
      <RadarIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium text-foreground">{statusLabel(monitor)}</span>
          {monitor?.headSha ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              {monitor.headSha.slice(0, 7)}
            </span>
          ) : null}
          {active ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <ActivityIcon className="size-3" />
              server-owned
            </span>
          ) : null}
          {monitor?.ownerThreadId ? (
            <span
              className="rounded bg-sky-500/10 px-1.5 py-0.5 font-mono text-[11px] text-sky-800 dark:text-sky-300"
              title={`Owner thread ${monitor.ownerThreadId}`}
            >
              owner {monitor.ownerThreadId.slice(0, 8)}
            </span>
          ) : null}
          {monitor?.linkedReviewThreadId ? (
            <span
              className="rounded bg-violet-500/10 px-1.5 py-0.5 font-mono text-[11px] text-violet-800 dark:text-violet-300"
              title={`Review thread ${monitor.linkedReviewThreadId}`}
            >
              review {monitor.linkedReviewThreadId.slice(0, 8)}
            </span>
          ) : null}
          {openFeedback.length > 0 ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
              {openFeedback.length} open feedback
            </span>
          ) : null}
        </div>
        {summary ? (
          <p className="mt-0.5 truncate text-muted-foreground" title={summary}>
            {summary}
          </p>
        ) : monitor?.lastError ? (
          <p className="mt-0.5 truncate text-destructive" title={monitor.lastError}>
            {monitor.lastError}
          </p>
        ) : null}
        {feedbackSummary ? (
          <p className="mt-0.5 truncate text-muted-foreground" title={feedbackSummary}>
            Feedback: {feedbackSummary}
          </p>
        ) : null}
        {deliverySummary ? (
          <p className="mt-0.5 truncate text-muted-foreground" title={deliverySummary}>
            {deliverySummary}
          </p>
        ) : null}
        {reportSummary ? (
          <p className="mt-0.5 truncate text-muted-foreground" title={reportSummary}>
            {reportSummary}
          </p>
        ) : null}
      </div>
      {showFallback ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2"
          onClick={onFallback}
        >
          <LifeBuoyIcon className="size-3.5" />
          Fallback
        </Button>
      ) : null}
      {active ? (
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2" onClick={onStop}>
          <PauseIcon className="size-3.5" />
          Stop
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2"
          onClick={onStart}
        >
          <PlayIcon className="size-3.5" />
          Monitor
        </Button>
      )}
    </div>
  );
}
