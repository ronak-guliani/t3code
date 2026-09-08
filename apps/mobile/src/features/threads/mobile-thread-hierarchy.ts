import {
  buildThreadTree,
  hierarchyThreadKey,
  normalizeParentThreadKeys,
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
export type NestedThreadReadMarkers = Readonly<Record<string, string>>;
export type MobileThreadTreeNode = ThreadTreeNode<MobileThreadShell, NestedThreadStatus> & {
  latestRelatedNotificationAt?: string | null;
  relatedStatus?: NestedThreadStatus;
  hasUnreadDescendant?: boolean;
  relatedChildCount?: number;
};
export type MobileThreadTreeRow = ThreadTreeRow<MobileThreadShell, NestedThreadStatus> & {
  readonly latestRelatedNotificationAt?: string | null;
  readonly relatedStatus?: NestedThreadStatus;
  readonly hasUnreadDescendant?: boolean;
  readonly relatedChildCount?: number;
};

export function nestedThreadKey(thread: MobileThreadShell): string {
  return thread.virtualAgentRun
    ? `${thread.environmentId}:agent-run:${thread.virtualAgentRun.parentThreadId}:${thread.virtualAgentRun.taskId}`
    : `${thread.environmentId}:${thread.id}`;
}

export function nestedThreadCompletionMarker(thread: MobileThreadShell): string | null {
  if (thread.virtualAgentRun) {
    if (thread.virtualAgentRun.status === "running") return null;
    return thread.virtualAgentRun.completedAt ?? thread.updatedAt;
  }
  if (thread.parentThreadId == null) return null;
  if (thread.latestTurn) {
    if (thread.latestTurn.state !== "running" && thread.latestTurn.completedAt !== null) {
      return thread.latestTurn.completedAt;
    }
    if (thread.latestTurn.state === "running") return null;
  }
  return thread.session?.status === "error" ? thread.session.updatedAt : null;
}

export function isNestedThreadRead(
  thread: MobileThreadShell,
  readMarkers: NestedThreadReadMarkers,
): boolean {
  const marker = nestedThreadCompletionMarker(thread);
  if (marker === null) return false;
  const readMarker = readMarkers[nestedThreadKey(thread)];
  if (!readMarker) return false;
  const markerMs = Date.parse(marker);
  const readMarkerMs = Date.parse(readMarker);
  return Number.isFinite(markerMs) && Number.isFinite(readMarkerMs) && markerMs <= readMarkerMs;
}

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
  options: {
    readonly readMarkers?: NestedThreadReadMarkers;
    readonly includeReadCompletedChildren?: boolean;
    readonly selectedThreadKey?: string | null;
  } = {},
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
  const readMarkers = options.readMarkers ?? {};
  // Read filtering affects rendered descendants, not whether the parent has
  // related chats that remain reachable from its row.
  const parentByKey = normalizeParentThreadKeys(expanded);
  const relatedChildCountByKey = new Map<string, number>();
  for (const thread of expanded) {
    let parentKey = parentByKey.get(hierarchyThreadKey(thread));
    const visited = new Set<string>();
    while (parentKey !== undefined && !visited.has(parentKey)) {
      relatedChildCountByKey.set(parentKey, (relatedChildCountByKey.get(parentKey) ?? 0) + 1);
      visited.add(parentKey);
      parentKey = parentByKey.get(parentKey);
    }
  }
  const visibleKeys = new Set(
    expanded
      .filter((thread) => {
        if (options.includeReadCompletedChildren === true || thread.parentThreadId == null) {
          return true;
        }
        if (hierarchyThreadKey(thread) === options.selectedThreadKey) return true;
        const status = resolveNestedThreadStatus(thread);
        if (status === "approval" || status === "input" || status === "working") return true;
        const completionMarker = nestedThreadCompletionMarker(thread);
        return completionMarker === null || !isNestedThreadRead(thread, readMarkers);
      })
      .map((thread) => hierarchyThreadKey(thread)),
  );
  const threadsByKey = new Map(expanded.map((thread) => [hierarchyThreadKey(thread), thread]));
  for (const thread of expanded) {
    if (!visibleKeys.has(hierarchyThreadKey(thread))) continue;
    let parentThreadId = thread.parentThreadId;
    while (parentThreadId != null) {
      const parentKey = hierarchyThreadKey({
        environmentId: thread.environmentId,
        id: parentThreadId,
      });
      if (!threadsByKey.has(parentKey)) break;
      visibleKeys.add(parentKey);
      parentThreadId = threadsByKey.get(parentKey)?.parentThreadId ?? null;
    }
  }
  const tree: MobileThreadTreeNode[] = buildThreadTree({
    threads: expanded.filter((thread) => visibleKeys.has(hierarchyThreadKey(thread))),
    compare,
    resolveStatus: resolveNestedThreadStatus,
    rollUpStatus: rollUpNestedThreadStatus,
    isArchiveBlocked: isThreadArchiveBlocked,
  });
  const visibleTreePending = [...tree];
  while (visibleTreePending.length > 0) {
    const node = visibleTreePending.pop()!;
    node.relatedChildCount = relatedChildCountByKey.get(node.threadKey) ?? node.descendantCount;
    visibleTreePending.push(...node.children);
  }
  // A collapsed group must retain notifications from deeper branches, including during search.
  const traversal: MobileThreadTreeNode[] = [];
  const pending: MobileThreadTreeNode[] = [...tree];
  while (pending.length > 0) {
    const node = pending.pop()!;
    traversal.push(node);
    for (const child of node.children) pending.push(child);
  }
  const latestByKey = new Map<string, string>();
  const unreadDescendantByKey = new Map<string, boolean>();
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
    node.hasUnreadDescendant = node.children.some(
      (child) =>
        unreadDescendantByKey.get(child.threadKey) === true ||
        (nestedThreadCompletionMarker(child.thread) !== null &&
          !isNestedThreadRead(child.thread, readMarkers)),
    );
    unreadDescendantByKey.set(node.threadKey, node.hasUnreadDescendant);
    if (latest) latestByKey.set(node.threadKey, latest);
  }
  return tree;
}

export function nestedThreadRevealKeys(
  nodes: readonly MobileThreadTreeNode[],
  readMarkers: NestedThreadReadMarkers,
): ReadonlySet<string> {
  const keys = new Set<string>();
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (
      node.thread.parentThreadId != null &&
      (node.status !== "ready" ||
        (nestedThreadCompletionMarker(node.thread) !== null &&
          !isNestedThreadRead(node.thread, readMarkers)))
    ) {
      keys.add(node.threadKey);
    }
    pending.push(...node.children);
  }
  return keys;
}

export function nestedVirtualAgentKeys(
  nodes: readonly MobileThreadTreeNode[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.thread.virtualAgentRun) keys.add(node.threadKey);
    pending.push(...node.children);
  }
  return keys;
}

export function nestedVirtualAgentSearchKeys(
  nodes: readonly MobileThreadTreeNode[],
  query: string,
): ReadonlySet<string> {
  const keys = new Set<string>();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) return keys;
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (
      node.thread.virtualAgentRun &&
      node.thread.title.toLocaleLowerCase().includes(normalizedQuery)
    ) {
      keys.add(node.threadKey);
    }
    pending.push(...node.children);
  }
  return keys;
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
        hasUnreadDescendant: node.hasUnreadDescendant === true,
        relatedChildCount: node.relatedChildCount ?? node.descendantCount,
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
    const nodeMatches = matches.has(hierarchyThreadKey(node.thread));
    if (nodeMatches) {
      for (const child of node.children) {
        if (
          child.thread.virtualAgentRun &&
          !children.some((item) => item.threadKey === child.threadKey)
        ) {
          children.push(child);
        }
      }
    }
    if (nodeMatches || children.length > 0) {
      // Keep full-subtree status and archive guards even when siblings are hidden.
      retained.set(node.threadKey, { ...node, children });
    }
  }
  return nodes.flatMap((node) => {
    const match = retained.get(node.threadKey);
    return match ? [match] : [];
  });
}
