import type { EnvironmentId, PullRequestMonitorRecord, PullRequestRef } from "@t3tools/contracts";
import { ActivityIcon, PauseIcon, PlayIcon, RadarIcon } from "lucide-react";
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
 * Observe-only control strip. Monitoring is server-owned; this UI only starts/stops/status.
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

  const monitor = statusQuery.data?.monitor ?? null;
  const active = monitor?.enabled === true;
  const summary = useMemo(() => blockersSummary(monitor), [monitor]);

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
        </div>
        {summary ? (
          <p className="mt-0.5 truncate text-muted-foreground" title={summary}>
            {summary}
          </p>
        ) : monitor?.lastError ? (
          <p className="mt-0.5 truncate text-destructive" title={monitor.lastError}>
            {monitor.lastError}
          </p>
        ) : (
          <p className="mt-0.5 text-muted-foreground">
            Polls checks, reviews, and threads. Merge stays human-controlled.
          </p>
        )}
      </div>
      {active ? (
        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => void onStop()}>
          <PauseIcon className="size-3" />
          Stop
        </Button>
      ) : (
        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => void onStart()}>
          <PlayIcon className="size-3" />
          Monitor
        </Button>
      )}
    </div>
  );
}
