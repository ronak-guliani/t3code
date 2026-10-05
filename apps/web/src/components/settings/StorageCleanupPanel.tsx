import type {
  StorageCategory,
  StorageCleanupItem,
  StorageCleanupPlan,
  StorageCleanupResult,
  StorageUsageSnapshot,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  storageExecuteCleanupMutationOptions,
  storagePreviewCleanupMutationOptions,
  storageUsageMutationOptions,
  storageUsageQueryOptions,
} from "../../lib/storageReactQuery";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";

export const STORAGE_CATEGORY_LABELS: Record<StorageCategory, string> = {
  worktrees: "Agent worktrees",
  worktreeTrash: "Worktree trash",
  providerLogs: "Provider logs",
  otherLogs: "Other logs",
  database: "Database",
  databaseBackups: "Database backups",
  attachments: "Attachments",
  browserArtifacts: "Browser artifacts",
  terminals: "Running terminals",
  validationEnvironments: "Validation environments",
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatPercent(value: number): string {
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)}%`;
}

function measurementStatus(usage: StorageUsageSnapshot | undefined): string {
  if (!usage) return "Loading…";
  switch (usage.status) {
    case "idle":
      return "Not measured yet";
    case "measuring":
      return "Measuring… (partial results)";
    case "cancelled":
      return "Measurement cancelled (partial results)";
    case "complete":
      return usage.completedAt
        ? `Measured ${new Date(usage.completedAt).toLocaleTimeString()}`
        : "Out of date";
  }
}

function UsageRow({ usage }: { usage: StorageUsageSnapshot["categories"][number] }) {
  const pending = usage.status === "pending" || usage.status === "measuring";
  return (
    <tr className="border-t border-border/60 first:border-t-0">
      <td className="py-1.5 pr-3 text-foreground">{STORAGE_CATEGORY_LABELS[usage.category]}</td>
      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
        {usage.category === "terminals" ? "—" : formatBytes(usage.bytes)}
        {pending ? <span className="ml-1 text-muted-foreground">…</span> : null}
      </td>
      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
        {usage.items.toLocaleString()}
      </td>
      <td className="py-1.5 text-muted-foreground">
        {usage.status === "failed"
          ? "Could not measure"
          : usage.reclaimableBytes !== undefined
            ? `${formatBytes(usage.reclaimableBytes)} reclaimable`
            : (usage.detail ?? "")}
      </td>
    </tr>
  );
}

export function StorageUsagePanel() {
  const environmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const usageQuery = useQuery(storageUsageQueryOptions(environmentId));
  const usageMutation = useMutation(storageUsageMutationOptions({ environmentId, queryClient }));
  const [dialogOpen, setDialogOpen] = useState(false);
  const usage = usageQuery.data;
  const measuring = usage?.status === "measuring";

  return (
    <div className="space-y-3 px-4 py-4 sm:px-5" data-testid="storage-usage-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold text-foreground">Disk usage</h3>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {measurementStatus(usage)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {measuring ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => usageMutation.mutate({ cancel: true })}
            >
              Cancel
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={usageMutation.isPending || !environmentId}
              onClick={() => usageMutation.mutate({ refresh: true })}
            >
              <RefreshCwIcon className="size-3" />
              Measure
            </Button>
          )}
          <Button size="xs" disabled={!environmentId} onClick={() => setDialogOpen(true)}>
            Clean up now…
          </Button>
        </div>
      </div>

      {usage?.lowDisk.active && usage.lowDisk.freePercent !== null ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          Low disk mode active ({formatPercent(usage.lowDisk.freePercent)} free): idle worktrees and
          logs are cleaned up sooner.
        </div>
      ) : null}
      {usage && !usage.automaticCleanupEnabled ? (
        <p className="text-xs text-muted-foreground">
          Automatic cleanup is paused. “Clean up now” still works.
        </p>
      ) : null}

      {usage ? (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="pb-1 text-left font-medium">Category</th>
              <th className="pb-1 text-right font-medium">Size</th>
              <th className="pb-1 text-right font-medium">Items</th>
              <th className="pb-1 pl-3 text-left font-medium" />
            </tr>
          </thead>
          <tbody>
            {usage.categories.map((category) => (
              <UsageRow key={category.category} usage={category} />
            ))}
          </tbody>
        </table>
      ) : usageQuery.isError ? (
        <p className="text-xs text-destructive">Storage usage is unavailable.</p>
      ) : (
        <Spinner className="size-4" />
      )}
      <p className="text-[11px] text-muted-foreground">
        Sizes are apparent sizes. APFS clones share blocks, so actual disk use can be smaller.
      </p>

      {usage && usage.manualReview.length > 0 ? (
        <div className="space-y-1 rounded-md border border-border/60 px-3 py-2">
          <p className="text-xs font-medium text-foreground">Needs manual review</p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {usage.manualReview.map((item) => (
              <li key={item.id} className="break-all">
                {item.description} — <span className="font-mono">{item.target}</span>
              </li>
            ))}
          </ul>
          <Button size="xs" variant="outline" onClick={() => setDialogOpen(true)}>
            Review and remove…
          </Button>
        </div>
      ) : null}

      {dialogOpen ? (
        <StorageCleanupDialog
          onClose={() => setDialogOpen(false)}
          cleanupProgress={usage?.cleanup ?? null}
        />
      ) : null}
    </div>
  );
}

function groupByCategory(items: ReadonlyArray<StorageCleanupItem>) {
  const groups = new Map<StorageCategory, StorageCleanupItem[]>();
  for (const item of items) {
    if (item.needsManualReview) continue;
    groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
  }
  return [...groups];
}

/** Mounted per opening, so every opening previews a fresh plan. */
export function StorageCleanupDialog({
  onClose,
  cleanupProgress,
}: {
  onClose: () => void;
  cleanupProgress: StorageUsageSnapshot["cleanup"];
}) {
  const environmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const preview = useMutation(storagePreviewCleanupMutationOptions(environmentId));
  const execute = useMutation(storageExecuteCleanupMutationOptions({ environmentId, queryClient }));
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const plan: StorageCleanupPlan | undefined = preview.data;
  const groups = useMemo(() => (plan ? groupByCategory(plan.items) : []), [plan]);
  const manualItems = useMemo(
    () => plan?.items.filter((item) => item.needsManualReview) ?? [],
    [plan],
  );
  const selectedBytes = useMemo(
    () =>
      plan?.items
        .filter((item) => selected.has(item.id))
        .reduce((sum, item) => sum + item.estimatedBytes, 0) ?? 0,
    [plan, selected],
  );

  const { mutate: runPreview } = preview;
  useEffect(() => {
    runPreview(undefined, {
      onSuccess: (next) =>
        setSelected(new Set(next.items.filter((item) => item.defaultSelected).map((i) => i.id))),
    });
  }, [runPreview]);
  const toggle = (ids: ReadonlyArray<string>, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const result: StorageCleanupResult | null =
    execute.data ??
    (plan && cleanupProgress?.planId === plan.planId ? cleanupProgress.result : null);
  const running = execute.isPending && result === null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !running) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl" data-testid="storage-cleanup-dialog">
        <DialogHeader>
          <DialogTitle>Clean up now</DialogTitle>
          <DialogDescription>
            Removes reclaimable files while keeping every chat, message, checkpoint, branch and pull
            request link. Reclaimed worktrees come back when their chat is reopened.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[60vh] space-y-3 overflow-y-auto text-xs">
          {preview.isPending ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-4" /> Finding what can be cleaned up…
            </div>
          ) : preview.isError ? (
            <p className="text-destructive">{preview.error.message}</p>
          ) : result ? (
            <CleanupResultSummary result={result} />
          ) : running ? (
            <div className="flex items-center gap-2 text-muted-foreground" role="status">
              <Spinner className="size-4" />
              Cleaning up
              {cleanupProgress && cleanupProgress.planId === plan?.planId
                ? ` (${cleanupProgress.completedItems}/${cleanupProgress.totalItems} items, ${formatBytes(cleanupProgress.bytesFreed)} freed)`
                : "…"}
            </div>
          ) : execute.isError ? (
            <p className="text-destructive">{execute.error.message}</p>
          ) : plan && plan.items.length === 0 ? (
            <p className="text-muted-foreground">Nothing can be cleaned up right now.</p>
          ) : plan ? (
            <>
              {groups.map(([category, items]) => {
                const total = plan.totals.find((entry) => entry.category === category);
                const checked = items.every((item) => selected.has(item.id));
                return (
                  <section key={category} className="space-y-1">
                    <label className="flex items-center gap-2 font-medium text-foreground">
                      <Checkbox
                        checked={checked}
                        aria-label={`Clean up ${STORAGE_CATEGORY_LABELS[category]}`}
                        onCheckedChange={(value) =>
                          toggle(
                            items.map((item) => item.id),
                            value === true,
                          )
                        }
                      />
                      {STORAGE_CATEGORY_LABELS[category]}
                      <span className="ml-auto font-mono text-muted-foreground">
                        ~{formatBytes(total?.estimatedBytes ?? 0)}
                      </span>
                    </label>
                    <ul className="space-y-0.5 pl-6 text-muted-foreground">
                      {items.map((item) => (
                        <li key={item.id} className="flex gap-2">
                          <span className="min-w-0 flex-1 truncate" title={item.target}>
                            {item.description}
                          </span>
                          <span className="font-mono">{formatBytes(item.estimatedBytes)}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              {manualItems.length > 0 ? (
                <section className="space-y-1 rounded-md border border-amber-500/40 p-2">
                  <p className="font-medium text-foreground">Needs manual review</p>
                  <p className="text-muted-foreground">
                    T3 cannot prove it owns these. Select an item only if you are sure; only its
                    files are removed and no process is stopped.
                  </p>
                  {manualItems.map((item) => (
                    <label key={item.id} className="flex items-start gap-2 text-muted-foreground">
                      <Checkbox
                        checked={selected.has(item.id)}
                        aria-label={`Remove ${item.target}`}
                        onCheckedChange={(value) => toggle([item.id], value === true)}
                      />
                      <span className="min-w-0 break-all">
                        {item.description}
                        <br />
                        <span className="font-mono">{item.target}</span>
                      </span>
                    </label>
                  ))}
                </section>
              ) : null}
            </>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {result ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" disabled={running} onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={!plan || selected.size === 0 || running}
                onClick={() =>
                  plan && execute.mutate({ planId: plan.planId, itemIds: [...selected] })
                }
              >
                {running ? "Cleaning up…" : `Clean up (frees ~${formatBytes(selectedBytes)})`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function CleanupResultSummary({ result }: { result: StorageCleanupResult }) {
  const removed = result.results.filter((entry) => entry.status === "removed");
  const notRemoved = result.results.filter((entry) => entry.status !== "removed");
  return (
    <div className="space-y-2" data-testid="storage-cleanup-result">
      <p className="text-sm font-medium text-foreground">
        Freed {formatBytes(result.bytesFreed)} · {removed.length} removed · {notRemoved.length}{" "}
        skipped
      </p>
      {notRemoved.length > 0 ? (
        <ul className="space-y-0.5 text-muted-foreground">
          {notRemoved.map((entry) => (
            <li key={entry.itemId}>
              <span className="text-foreground">{entry.description}</span>
              {entry.status === "failed" ? " failed" : " skipped"}: {entry.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
