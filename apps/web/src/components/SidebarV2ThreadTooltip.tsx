import {
  CircleAlertIcon,
  ClockIcon,
  FolderIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { sanitizeThreadErrorMessage } from "../rpc/transportError";
import type { ProviderInstanceEntry } from "../providerInstances";
import type { SidebarThreadSummary } from "../types";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { prStatusIndicator } from "./ThreadStatusIndicators";
import { TooltipPopup } from "./ui/tooltip";

export function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

/** Remote rows name their environment; primary-environment rows stay unlabelled
    so the common case spends no space on it. */
export function useThreadEnvironmentLabel(thread: SidebarThreadSummary): {
  readonly isRemote: boolean;
  readonly environmentLabel: string | null;
} {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemote = primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteRuntimeLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[thread.environmentId]?.descriptor?.label ?? null,
  );
  const remoteSavedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[thread.environmentId]?.label ?? null,
  );
  return {
    isRemote,
    environmentLabel: isRemote ? (remoteRuntimeLabel ?? remoteSavedLabel ?? "Remote") : null,
  };
}

export function ThreadDetailsTooltip({
  thread,
  projectName,
  projectCwd,
  environmentLabel,
  providerEntry,
  terminalProcessCount,
}: {
  readonly thread: SidebarThreadSummary;
  readonly projectName: string;
  readonly projectCwd: string | null;
  readonly environmentLabel: string | null;
  readonly providerEntry: ProviderInstanceEntry | null;
  readonly terminalProcessCount: number;
}) {
  const driverKind = providerEntry?.driverKind ?? thread.session?.provider ?? null;
  const prStatus = prStatusIndicator(thread.pullRequest);
  // Transport drops are connection noise, not a thread failure; the same
  // sanitizer the chat surface uses keeps them out of the tooltip.
  const sessionError = sanitizeThreadErrorMessage(thread.session?.lastError);
  const workspacePath = thread.worktreePath ?? projectCwd;
  return (
    <TooltipPopup
      align="start"
      className="max-w-72 rounded-lg whitespace-normal text-left transition-opacity duration-100 ease-out motion-reduce:transition-none"
      side="right"
      sideOffset={8}
    >
      <div className="flex min-w-0 flex-col gap-2 px-1 py-1.5 text-[11px] leading-4 text-muted-foreground">
        <div className="line-clamp-2 min-w-0 text-xs font-medium leading-4 wrap-break-word text-foreground">
          {thread.title}
        </div>
        <div className="grid min-w-0 gap-1.5">
          <div className="flex min-w-0 items-start gap-2">
            <GitBranchIcon className="mt-0.5 size-3 shrink-0" />
            <div className="min-w-0">
              <div className="truncate text-foreground/80">{projectName}</div>
              {thread.branch ? <div className="truncate">{thread.branch}</div> : null}
            </div>
          </div>
          {workspacePath ? (
            <div className="flex min-w-0 items-center gap-2">
              <FolderIcon className="size-3 shrink-0" />
              <div className="min-w-0 truncate">{workspacePath}</div>
            </div>
          ) : null}
          {environmentLabel ? (
            <div className="flex min-w-0 items-center gap-2">
              <ServerIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
            </div>
          ) : null}
          {terminalProcessCount > 0 ? (
            <div className="flex min-w-0 items-center gap-2">
              <TerminalIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">
                {terminalProcessLabel(terminalProcessCount)}
              </div>
            </div>
          ) : null}
          {prStatus ? (
            <div className="flex min-w-0 items-center gap-2">
              <GitPullRequestIcon className={`size-3 shrink-0 ${prStatus.colorClass}`} />
              <div className="min-w-0 truncate text-foreground/75">{prStatus.tooltip}</div>
            </div>
          ) : null}
          <div className="flex min-w-0 items-center gap-3 text-[10px]">
            {driverKind ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <ProviderInstanceIcon
                  displayName={providerEntry?.displayName ?? driverKind}
                  driverKind={driverKind}
                  iconClassName="size-3 shrink-0 grayscale opacity-60"
                />
                <span className="truncate">{providerEntry?.displayName ?? driverKind}</span>
              </div>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <ClockIcon className="size-3" />
              {formatRelativeTimeLabel(
                thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
              )}
            </div>
          </div>
          {sessionError ? (
            <div className="flex min-w-0 items-start gap-2 text-red-600 dark:text-red-400">
              <CircleAlertIcon className="mt-0.5 size-3 shrink-0 stroke-current" />
              <div className="min-w-0 flex-1 wrap-break-word">{sessionError}</div>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipPopup>
  );
}
