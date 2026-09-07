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
export type NestedThreadReadMarkers = Readonly<Record<string, string>>;
export type MobileThreadTreeNode = ThreadTreeNode<MobileThreadShell, NestedThreadStatus>;
export type MobileThreadTreeRow = ThreadTreeRow<MobileThreadShell, NestedThreadStatus>;
export const NO_THREAD_EXPANSION_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

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
  if (thread.parentThreadId == null || thread.latestTurn === null) return null;
  if (thread.latestTurn.state === "running" || thread.latestTurn.completedAt === null) {
    return null;
  }
  return thread.latestTurn.completedAt;
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
  if (thread.virtualAgentRun?.status === "failed" || thread.session?.status === "error")
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
  const visibleKeys = new Set(
    expanded
      .filter(
        (thread) =>
          options.includeReadCompletedChildren === true ||
          thread.parentThreadId == null ||
          resolveNestedThreadStatus(thread) !== "ready" ||
          !isNestedThreadRead(thread, readMarkers),
      )
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
  return buildThreadTree({
    threads: expanded.filter((thread) => visibleKeys.has(hierarchyThreadKey(thread))),
    compare,
    resolveStatus: resolveNestedThreadStatus,
    rollUpStatus: rollUpNestedThreadStatus,
    isArchiveBlocked: isThreadArchiveBlocked,
  });
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
      node.status === "ready" &&
      nestedThreadCompletionMarker(node.thread) !== null &&
      !isNestedThreadRead(node.thread, readMarkers)
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
