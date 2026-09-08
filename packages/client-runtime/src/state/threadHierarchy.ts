export interface HierarchicalThread {
  readonly id: string;
  readonly environmentId: string;
  readonly parentThreadId?: string | null;
  readonly archivedAt: string | null;
}

export function hierarchyThreadKey(
  thread: Pick<HierarchicalThread, "environmentId" | "id">,
): string {
  return `${thread.environmentId}:${thread.id}`;
}

export function hasUnseenChildNotification(thread: {
  readonly latestChildNotificationAt?: string | null | undefined;
  readonly lastVisitedAt?: string | null | undefined;
}): boolean {
  if (!thread.latestChildNotificationAt) return false;
  const notificationAt = Date.parse(thread.latestChildNotificationAt);
  if (Number.isNaN(notificationAt)) return false;
  if (!thread.lastVisitedAt) return true;
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  return Number.isNaN(lastVisitedAt) || notificationAt > lastVisitedAt;
}

/** Missing parents become roots. Never attach to another environment or retain a cycle. */
export function normalizeParentThreadKeys<T extends HierarchicalThread>(
  threads: readonly T[],
): Map<string, string> {
  const keys = new Set(threads.map(hierarchyThreadKey));
  const parents = new Map<string, string>();
  for (const thread of threads) {
    if (thread.parentThreadId == null) continue;
    const key = hierarchyThreadKey(thread);
    const parent = hierarchyThreadKey({
      environmentId: thread.environmentId,
      id: thread.parentThreadId,
    });
    if (parent !== key && keys.has(parent)) parents.set(key, parent);
  }
  const resolved = new Set<string>();
  for (const key of parents.keys()) {
    const path = new Set<string>([key]);
    let parent = parents.get(key);
    while (parent !== undefined && !resolved.has(parent)) {
      if (path.has(parent)) {
        parents.delete(parent);
        break;
      }
      path.add(parent);
      parent = parents.get(parent);
    }
    for (const visited of path) resolved.add(visited);
  }
  return parents;
}

/** Filter before normalization so an archived ancestor cannot resurrect its descendants. */
export function selectVisibleThreads<T extends HierarchicalThread>(threads: readonly T[]): T[] {
  const byKey = new Map(threads.map((thread) => [hierarchyThreadKey(thread), thread]));
  const visibility = new Map<string, boolean>();
  for (const thread of threads) {
    let candidate: T | undefined = thread;
    const path = new Set<string>();
    let visible = true;
    while (candidate !== undefined) {
      const key = hierarchyThreadKey(candidate);
      const cached = visibility.get(key);
      if (cached !== undefined) {
        visible = cached;
        break;
      }
      if (path.has(key)) break;
      path.add(key);
      if (candidate.archivedAt !== null) {
        visible = false;
        break;
      }
      candidate =
        candidate.parentThreadId == null
          ? undefined
          : byKey.get(
              hierarchyThreadKey({
                environmentId: candidate.environmentId,
                id: candidate.parentThreadId,
              }),
            );
    }
    for (const key of path) visibility.set(key, visible);
  }
  return threads.filter((thread) => visibility.get(hierarchyThreadKey(thread)) !== false);
}

export function isThreadInSubtree(
  threads: readonly { readonly id: string; readonly parentThreadId?: string | null }[],
  rootThreadId: string,
  threadId: string,
): boolean {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const visited = new Set<string>();
  let candidate: string | null = threadId;
  while (candidate !== null && !visited.has(candidate)) {
    if (candidate === rootThreadId) return true;
    visited.add(candidate);
    candidate = byId.get(candidate)?.parentThreadId ?? null;
  }
  return false;
}

export function includeThreadAncestors<T extends HierarchicalThread>(
  threads: readonly T[],
  matchingKeys: ReadonlySet<string>,
): T[] {
  const parents = normalizeParentThreadKeys(threads);
  const included = new Set(matchingKeys);
  for (const key of matchingKeys) {
    let parent = parents.get(key);
    while (parent !== undefined && !included.has(parent)) {
      included.add(parent);
      parent = parents.get(parent);
    }
  }
  return threads.filter((thread) => included.has(hierarchyThreadKey(thread)));
}

export interface ThreadTreeNode<T, S> {
  readonly thread: T;
  readonly threadKey: string;
  readonly children: ThreadTreeNode<T, S>[];
  mostRecentThread: T;
  readonly status: S;
  rolledUpStatus: S;
  descendantCount: number;
  archiveBlocked: boolean;
}

export interface ThreadTreeRow<T, S> {
  readonly thread: T;
  readonly threadKey: string;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly isExpanded: boolean;
  readonly childCount: number;
  readonly displayStatus: S;
  readonly archiveBlocked: boolean;
}

/** Sort siblings once, then compute rollups bottom-up without recursive stack growth. */
export function buildThreadTree<T extends HierarchicalThread, S>(input: {
  readonly threads: readonly T[];
  readonly compare: (left: T, right: T) => number;
  readonly resolveStatus: (thread: T) => S;
  readonly rollUpStatus: (statuses: readonly S[]) => S;
  readonly isArchiveBlocked: (thread: T) => boolean;
}): ThreadTreeNode<T, S>[] {
  const parents = normalizeParentThreadKeys(input.threads);
  const sorted = [...input.threads].sort(input.compare);
  const nodes = new Map<string, ThreadTreeNode<T, S>>(
    sorted.map((thread) => {
      const threadKey = hierarchyThreadKey(thread);
      const status = input.resolveStatus(thread);
      return [
        threadKey,
        {
          thread,
          threadKey,
          children: [],
          mostRecentThread: thread,
          status,
          rolledUpStatus: status,
          descendantCount: 0,
          archiveBlocked: input.isArchiveBlocked(thread),
        },
      ];
    }),
  );
  const roots: ThreadTreeNode<T, S>[] = [];
  for (const node of nodes.values()) {
    const parentKey = parents.get(node.threadKey);
    const parent = parentKey === undefined ? undefined : nodes.get(parentKey);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const traversal: ThreadTreeNode<T, S>[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    traversal.push(node);
    for (const child of node.children) stack.push(child);
  }
  for (let index = traversal.length - 1; index >= 0; index--) {
    const node = traversal[index]!;
    node.rolledUpStatus = input.rollUpStatus([
      node.status,
      ...node.children.map((child) => child.rolledUpStatus),
    ]);
    for (const child of node.children) {
      node.descendantCount += 1 + child.descendantCount;
      node.archiveBlocked ||= child.archiveBlocked;
      if (input.compare(child.mostRecentThread, node.mostRecentThread) < 0) {
        node.mostRecentThread = child.mostRecentThread;
      }
    }
  }
  return roots;
}

/** Active descendants remain visible even after an explicit collapse, matching the fork sidebar. */
export function flattenThreadTree<T, S>(input: {
  readonly nodes: readonly ThreadTreeNode<T, S>[];
  readonly expandedOverrideByThreadKey: ReadonlyMap<string, boolean>;
  readonly activeThreadKey?: string | null | undefined;
  readonly revealThreadKeys?: ReadonlySet<string> | undefined;
  readonly isActiveStatus: (status: S) => boolean;
}): ThreadTreeRow<T, S>[] {
  const traversal: ThreadTreeNode<T, S>[] = [];
  const stack = [...input.nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    traversal.push(node);
    for (const child of node.children) stack.push(child);
  }
  const revealed = new Set<string>();
  for (let index = traversal.length - 1; index >= 0; index--) {
    const node = traversal[index]!;
    if (
      node.threadKey === input.activeThreadKey ||
      input.revealThreadKeys?.has(node.threadKey) ||
      node.children.some((child) => revealed.has(child.threadKey))
    ) {
      revealed.add(node.threadKey);
    }
  }
  const rows: ThreadTreeRow<T, S>[] = [];
  const pending: { node: ThreadTreeNode<T, S>; depth: number }[] = [];
  for (let index = input.nodes.length - 1; index >= 0; index--) {
    pending.push({ node: input.nodes[index]!, depth: 0 });
  }
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    const hasChildren = node.children.length > 0;
    const isExpanded =
      hasChildren &&
      (node.children.some(
        (child) => revealed.has(child.threadKey) || input.isActiveStatus(child.rolledUpStatus),
      ) ||
        (input.expandedOverrideByThreadKey.get(node.threadKey) ??
          input.isActiveStatus(node.rolledUpStatus)));
    rows.push({
      thread: node.thread,
      threadKey: node.threadKey,
      depth,
      hasChildren,
      isExpanded,
      childCount: node.descendantCount,
      displayStatus: node.rolledUpStatus,
      archiveBlocked: node.archiveBlocked,
    });
    if (isExpanded) {
      for (let index = node.children.length - 1; index >= 0; index--) {
        pending.push({ node: node.children[index]!, depth: depth + 1 });
      }
    }
  }
  return rows;
}
