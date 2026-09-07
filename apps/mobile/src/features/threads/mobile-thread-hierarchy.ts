import {
  buildThreadTree,
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
export type MobileThreadTreeNode = ThreadTreeNode<MobileThreadShell, NestedThreadStatus> & {
  latestRelatedNotificationAt?: string | null;
  relatedStatus?: NestedThreadStatus;
};
export type MobileThreadTreeRow = ThreadTreeRow<MobileThreadShell, NestedThreadStatus> & {
  readonly latestRelatedNotificationAt?: string | null;
  readonly relatedStatus?: NestedThreadStatus;
};

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
  if (
    thread.virtualAgentRun?.status === "failed" ||
    thread.session?.status === "error" ||
    thread.latestTurn?.state === "error"
  )
    return "failed";
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
  const tree: MobileThreadTreeNode[] = buildThreadTree({
    threads: expanded,
    compare,
    resolveStatus: resolveNestedThreadStatus,
    rollUpStatus: rollUpNestedThreadStatus,
    isArchiveBlocked: isThreadArchiveBlocked,
  });
  // A collapsed group must retain notifications from deeper branches, including during search.
  const traversal: MobileThreadTreeNode[] = [];
  const pending: MobileThreadTreeNode[] = [...tree];
  while (pending.length > 0) {
    const node = pending.pop()!;
    traversal.push(node);
    for (const child of node.children) pending.push(child);
  }
  const latestByKey = new Map<string, string>();
  for (let index = traversal.length - 1; index >= 0; index--) {
    const node = traversal[index]!;
    let latest = node.thread.latestChildNotificationAt ?? null;
    for (const child of node.children) {
      const childLatest = latestByKey.get(child.threadKey);
      if (childLatest && (!latest || Date.parse(childLatest) > Date.parse(latest)))
        latest = childLatest;
    }
    node.latestRelatedNotificationAt = latest;
    node.relatedStatus = rollUpNestedThreadStatus(
      node.children.map((child) => child.rolledUpStatus),
    );
    if (latest) latestByKey.set(node.threadKey, latest);
  }
  return tree;
}

export function mobileThreadTreeRows(
  nodes: readonly MobileThreadTreeNode[],
  options: {
    readonly selectedThreadKey?: string | null | undefined;
    readonly revealThreadKeys?: ReadonlySet<string> | undefined;
  } = {},
): MobileThreadTreeRow[] {
  const rows: MobileThreadTreeRow[] = [];
  const pending: Array<{ node: MobileThreadTreeNode; depth: number }> = [];
  for (let index = nodes.length - 1; index >= 0; index--) {
    pending.push({ node: nodes[index]!, depth: 0 });
  }
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    // Search and the selected iPad conversation stay directly reachable.
    // Activity alone never expands the inbox into a tree.
    if (
      depth === 0 ||
      node.threadKey === options.selectedThreadKey ||
      options.revealThreadKeys?.has(node.threadKey)
    ) {
      rows.push({
        thread: node.thread,
        threadKey: node.threadKey,
        depth,
        hasChildren: node.descendantCount > 0,
        isExpanded: false,
        childCount: node.descendantCount,
        displayStatus: node.rolledUpStatus,
        archiveBlocked: node.archiveBlocked,
        latestRelatedNotificationAt: node.latestRelatedNotificationAt ?? null,
        relatedStatus: node.relatedStatus ?? "ready",
      });
    }
    for (let index = node.children.length - 1; index >= 0; index--) {
      pending.push({ node: node.children[index]!, depth: depth + 1 });
    }
  }
  return rows;
}

export function relatedThreadRows(
  nodes: readonly MobileThreadTreeNode[],
  threadKey: string,
): MobileThreadTreeRow[] {
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.threadKey === threadKey) {
      const revealThreadKeys = new Set<string>();
      const descendants = [node];
      while (descendants.length > 0) {
        const descendant = descendants.pop()!;
        revealThreadKeys.add(descendant.threadKey);
        descendants.push(...descendant.children);
      }
      return mobileThreadTreeRows([node], { revealThreadKeys });
    }
    pending.push(...node.children);
  }
  return [];
}

/** A search match keeps its ancestors rather than presenting a child as a new root. */
export function selectMatchingThreadTree(
  nodes: readonly MobileThreadTreeNode[],
  matches: ReadonlySet<string>,
): MobileThreadTreeNode[] {
  const traversal: MobileThreadTreeNode[] = [];
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    traversal.push(node);
    for (const child of node.children) pending.push(child);
  }
  const retained = new Map<string, MobileThreadTreeNode>();
  for (let index = traversal.length - 1; index >= 0; index--) {
    const node = traversal[index]!;
    const children = node.children.flatMap((child) => {
      const match = retained.get(child.threadKey);
      return match ? [match] : [];
    });
    if (matches.has(hierarchyThreadKey(node.thread)) || children.length > 0) {
      // Keep full-subtree status and archive guards even when siblings are hidden.
      retained.set(node.threadKey, { ...node, children });
    }
  }
  return nodes.flatMap((node) => {
    const match = retained.get(node.threadKey);
    return match ? [match] : [];
  });
}
