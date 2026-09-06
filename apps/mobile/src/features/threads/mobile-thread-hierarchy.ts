import {
  buildThreadTree,
  flattenThreadTree,
  hierarchyThreadKey,
  selectVisibleThreads,
  type ThreadTreeNode,
  type ThreadTreeRow,
} from "@t3tools/client-runtime/state/thread-hierarchy";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { ThreadId, type OrchestrationBackgroundAgentRunShell } from "@t3tools/contracts";

export type NestedThreadStatus = "approval" | "input" | "working" | "failed" | "ready";
export interface MobileThreadShell extends EnvironmentThreadShell {
  readonly virtualAgentRun?: OrchestrationBackgroundAgentRunShell & {
    readonly parentThreadId: ThreadId;
  };
}
export type MobileThreadTreeNode = ThreadTreeNode<MobileThreadShell, NestedThreadStatus>;
export type MobileThreadTreeRow = ThreadTreeRow<MobileThreadShell, NestedThreadStatus>;
export const NO_THREAD_EXPANSION_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

export function nestedThreadParentError(
  parentThreadId: ThreadId | undefined,
  projectId: EnvironmentThreadShell["projectId"],
  threads: readonly EnvironmentThreadShell[],
): string | null {
  if (parentThreadId === undefined) return null;
  const parent = threads.find((thread) => thread.id === parentThreadId);
  return !parent || parent.archivedAt !== null
    ? "The parent chat is no longer active. Restore it before sending this subchat."
    : parent.projectId !== projectId
      ? "The parent chat belongs to a different project."
      : null;
}

export function resolveNestedThreadStatus(
  thread: Pick<EnvironmentThreadShell, "hasPendingApprovals" | "hasPendingUserInput" | "session"> &
    Partial<Pick<MobileThreadShell, "hasPendingQueuedTurn" | "latestTurn" | "virtualAgentRun">>,
): NestedThreadStatus {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (
    thread.virtualAgentRun?.status === "running" ||
    thread.hasPendingQueuedTurn ||
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running"
  )
    return "working";
  if (thread.session?.status === "error") return "failed";
  return "ready";
}

const STATUS_PRIORITY: readonly NestedThreadStatus[] = [
  "approval",
  "input",
  "working",
  "failed",
  "ready",
];
export function rollUpNestedThreadStatus(
  statuses: readonly NestedThreadStatus[],
): NestedThreadStatus {
  return STATUS_PRIORITY.find((status) => statuses.includes(status)) ?? "ready";
}

export function isThreadArchiveBlocked(thread: MobileThreadShell): boolean {
  return (
    thread.virtualAgentRun?.status === "running" ||
    thread.backgroundAgentRuns?.some((run) => run.status === "running") === true ||
    thread.hasPendingQueuedTurn ||
    (thread.session?.status === "running" && thread.session.activeTurnId != null)
  );
}

export function compareNestedThreads(
  left: EnvironmentThreadShell,
  right: EnvironmentThreadShell,
): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title);
}

export function buildMobileThreadTree(
  threads: readonly EnvironmentThreadShell[],
  compare = compareNestedThreads,
  dismissedAgentRunKeys: readonly string[] = [],
): MobileThreadTreeNode[] {
  const dismissed = new Set(dismissedAgentRunKeys);
  const expanded: MobileThreadShell[] = selectVisibleThreads(threads).flatMap((thread) => [
    thread,
    ...(thread.backgroundAgentRuns ?? [])
      .filter(
        (run) => !dismissed.has(`${thread.environmentId}:agent-run:${thread.id}:${run.taskId}`),
      )
      .map(
        (run): MobileThreadShell => ({
          ...thread,
          id: ThreadId.make(`agent-run:${thread.id}:${run.taskId}`),
          parentThreadId: thread.id,
          title: run.name,
          createdAt: run.startedAt,
          updatedAt: run.completedAt ?? run.startedAt,
          session: null,
          latestTurn: null,
          latestUserMessageAt: null,
          latestChildNotificationAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasPendingQueuedTurn: false,
          hasActionableProposedPlan: false,
          backgroundAgentRuns: [],
          virtualAgentRun: { ...run, parentThreadId: thread.id },
        }),
      ),
  ]);
  return buildThreadTree({
    threads: expanded,
    compare,
    resolveStatus: resolveNestedThreadStatus,
    rollUpStatus: rollUpNestedThreadStatus,
    isArchiveBlocked: isThreadArchiveBlocked,
  });
}

export function mobileThreadTreeRows(
  nodes: readonly MobileThreadTreeNode[],
  options: {
    readonly expandedOverrideByThreadKey?: ReadonlyMap<string, boolean> | undefined;
    readonly selectedThreadKey?: string | null | undefined;
    readonly revealThreadKeys?: ReadonlySet<string> | undefined;
  } = {},
): MobileThreadTreeRow[] {
  return flattenThreadTree({
    nodes,
    expandedOverrideByThreadKey:
      options.expandedOverrideByThreadKey ?? NO_THREAD_EXPANSION_OVERRIDES,
    activeThreadKey: options.selectedThreadKey,
    revealThreadKeys: options.revealThreadKeys,
    isActiveStatus: (status) => status !== "ready",
  });
}

/** A search match keeps its ancestors rather than presenting a child as a new root. */
export function selectMatchingThreadTree(
  nodes: readonly MobileThreadTreeNode[],
  matches: ReadonlySet<string>,
): MobileThreadTreeNode[] {
  return nodes.filter((root) => {
    const pending = [root];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (matches.has(hierarchyThreadKey(node.thread))) return true;
      for (const child of node.children) pending.push(child);
    }
    return false;
  });
}
