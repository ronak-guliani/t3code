import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import type { HomeThreadGroup } from "./homeThreadList";
import {
  buildMobileThreadTree,
  mobileThreadTreeRows,
  type MobileThreadTreeRow,
  type MobileThreadShell,
  compareNestedThreads,
} from "../threads/mobile-thread-hierarchy";

/** Threads shown per project before the "Show more" affordance appears. */
export const HOME_INITIAL_VISIBLE_THREADS = 6;
/** Additional threads revealed per "Show more" tap. */
export const HOME_SHOW_MORE_STEP = 10;

export interface HomeGroupDisplayState {
  readonly collapsed: boolean;
  /** How many threads are currently revealed (clamped to the group size). */
  readonly visibleCount: number;
}

export const DEFAULT_GROUP_DISPLAY_STATE: HomeGroupDisplayState = {
  collapsed: false,
  visibleCount: HOME_INITIAL_VISIBLE_THREADS,
};

export interface HomeHeaderListItem {
  readonly type: "header";
  readonly key: string;
  readonly group: HomeThreadGroup;
  readonly collapsed: boolean;
  readonly isFirst: boolean;
}

export interface HomeThreadListItem {
  readonly type: "thread";
  readonly key: string;
  readonly thread: MobileThreadShell;
  readonly hierarchy?: MobileThreadTreeRow;
  readonly isLast: boolean;
}

export interface HomePendingTaskListItem {
  readonly type: "pending-task";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  readonly isLast: boolean;
}

export interface HomeShowMoreListItem {
  readonly type: "show-more";
  readonly key: string;
  readonly groupKey: string;
  /** Threads still hidden. 0 means the group is fully expanded. */
  readonly hiddenCount: number;
  /** Whether more than the initial count is revealed, so "Show less" applies. */
  readonly canShowLess: boolean;
}

export type HomeListItem =
  | HomeHeaderListItem
  | HomePendingTaskListItem
  | HomeThreadListItem
  | HomeShowMoreListItem;

export interface HomeListLayout {
  readonly items: ReadonlyArray<HomeListItem>;
  readonly stickyHeaderIndices: ReadonlyArray<number>;
}

export const EMPTY_HOME_LIST_LAYOUT: HomeListLayout = { items: [], stickyHeaderIndices: [] };

export type HomeGroupDisplayAction = "toggle-collapsed" | "show-more" | "show-less";

export function nextGroupDisplayState(
  current: HomeGroupDisplayState,
  action: HomeGroupDisplayAction,
): HomeGroupDisplayState {
  switch (action) {
    case "toggle-collapsed":
      return { ...current, collapsed: !current.collapsed };
    case "show-more":
      return { ...current, visibleCount: current.visibleCount + HOME_SHOW_MORE_STEP };
    case "show-less":
      return { ...current, visibleCount: HOME_INITIAL_VISIBLE_THREADS };
  }
}

/**
 * Structural equality for list items. Item objects are rebuilt on every
 * collapse/show-more toggle; without this the lists would consider every
 * mounted row changed and re-render all of them (each carrying a swipeable +
 * a vcs-status subscription). Group/thread references are stable across
 * toggles.
 */
export function homeListItemsAreEqual(previous: HomeListItem, item: HomeListItem): boolean {
  switch (item.type) {
    case "header":
      return (
        previous.type === "header" &&
        previous.group === item.group &&
        previous.collapsed === item.collapsed &&
        previous.isFirst === item.isFirst
      );
    case "pending-task":
      return (
        previous.type === "pending-task" &&
        previous.pendingTask === item.pendingTask &&
        previous.isLast === item.isLast
      );
    case "thread":
      return (
        previous.type === "thread" &&
        previous.thread === item.thread &&
        previous.hierarchy?.depth === item.hierarchy?.depth &&
        previous.hierarchy?.isExpanded === item.hierarchy?.isExpanded &&
        previous.hierarchy?.childCount === item.hierarchy?.childCount &&
        previous.hierarchy?.displayStatus === item.hierarchy?.displayStatus &&
        previous.hierarchy?.archiveBlocked === item.hierarchy?.archiveBlocked &&
        previous.isLast === item.isLast
      );
    case "show-more":
      return (
        previous.type === "show-more" &&
        previous.groupKey === item.groupKey &&
        previous.hiddenCount === item.hiddenCount &&
        previous.canShowLess === item.canShowLess
      );
  }
}

export function buildHomeListLayout(input: {
  readonly groups: ReadonlyArray<HomeThreadGroup>;
  readonly displayStates: ReadonlyMap<string, HomeGroupDisplayState>;
  /**
   * When searching, pagination is suspended so every match stays visible.
   */
  readonly showAllThreads?: boolean;
  readonly expandedOverrideByThreadKey?: ReadonlyMap<string, boolean>;
  readonly dismissedAgentRunKeys?: readonly string[];
  readonly selectedThreadKey?: string | null;
}): HomeListLayout {
  const items: HomeListItem[] = [];
  const stickyHeaderIndices: number[] = [];

  for (const [groupIndex, group] of input.groups.entries()) {
    const display = input.displayStates.get(group.key) ?? DEFAULT_GROUP_DISPLAY_STATE;
    const collapsed = display.collapsed && input.showAllThreads !== true;

    stickyHeaderIndices.push(items.length);
    items.push({
      type: "header",
      key: `header:${group.key}`,
      group,
      collapsed,
      isFirst: groupIndex === 0,
    });

    if (collapsed) {
      continue;
    }

    const ordinalByThreadKey = new Map(
      group.threads.map((thread, index) => [`${thread.environmentId}:${thread.id}`, index]),
    );
    const ordinal = (thread: MobileThreadShell) =>
      ordinalByThreadKey.get(
        `${thread.environmentId}:${thread.virtualAgentRun?.parentThreadId ?? thread.id}`,
      ) ?? Number.POSITIVE_INFINITY;
    // Synthetic rows share their parent's position; never mix two different
    // comparators for real and synthetic rows, which makes sorting non-transitive.
    const roots = buildMobileThreadTree(
      group.threads,
      (left, right) => ordinal(left) - ordinal(right) || compareNestedThreads(left, right),
      input.dismissedAgentRunKeys,
    ).sort((left, right) => ordinal(left.mostRecentThread) - ordinal(right.mostRecentThread));
    const totalCount = roots.length;
    // Default to the group's recent-activity window (last few days, or a small
    // fallback for stale projects), capped at the initial page size. Until the
    // user taps "Show more", older threads stay hidden to save vertical space;
    // "Show less" resets visibleCount to the initial constant, which lands back
    // here at the recency baseline.
    const recentThreadKeys = new Set(
      group.recentThreads.map((thread) => `${thread.environmentId}:${thread.id}`),
    );
    const baselineCount = Math.min(
      roots.filter((node) =>
        recentThreadKeys.has(
          `${node.mostRecentThread.environmentId}:${node.mostRecentThread.virtualAgentRun?.parentThreadId ?? node.mostRecentThread.id}`,
        ),
      ).length,
      HOME_INITIAL_VISIBLE_THREADS,
      totalCount,
    );
    const visibleCount = input.showAllThreads
      ? totalCount
      : Math.min(
          display.visibleCount > HOME_INITIAL_VISIBLE_THREADS
            ? display.visibleCount
            : baselineCount,
          totalCount,
        );
    const rows = roots.map((root) =>
      mobileThreadTreeRows([root], {
        expandedOverrideByThreadKey: input.expandedOverrideByThreadKey,
        selectedThreadKey: input.selectedThreadKey,
        ...(input.showAllThreads
          ? {
              revealThreadKeys: new Set(
                group.threads.map((thread) => `${thread.environmentId}:${thread.id}`),
              ),
            }
          : {}),
      }),
    );
    const visibleThreads = rows
      .filter(
        (rootRows, index) =>
          index < visibleCount || rootRows.some((row) => row.threadKey === input.selectedThreadKey),
      )
      .flat();
    const visibleRootCount = rows.filter(
      (rootRows, index) =>
        index < visibleCount || rootRows.some((row) => row.threadKey === input.selectedThreadKey),
    ).length;
    const hiddenCount = totalCount - visibleRootCount;
    const hasShowMoreRow = !input.showAllThreads && totalCount > baselineCount;

    // Pending (unsent) tasks lead the group and are never paginated away.
    for (const [pendingIndex, pendingTask] of group.pendingTasks.entries()) {
      items.push({
        type: "pending-task",
        key: `pending-task:${pendingTask.message.messageId}`,
        pendingTask,
        isLast:
          pendingIndex === group.pendingTasks.length - 1 &&
          visibleThreads.length === 0 &&
          !hasShowMoreRow,
      });
    }

    for (const [threadIndex, hierarchy] of visibleThreads.entries()) {
      const thread = hierarchy.thread;
      items.push({
        type: "thread",
        key: `thread:${thread.environmentId}:${thread.id}`,
        thread,
        hierarchy,
        isLast: threadIndex === visibleThreads.length - 1 && !hasShowMoreRow,
      });
    }

    if (hasShowMoreRow) {
      items.push({
        type: "show-more",
        key: `show-more:${group.key}`,
        groupKey: group.key,
        hiddenCount,
        // Compare against the group's own baseline, not the global page size:
        // stale projects start below HOME_INITIAL_VISIBLE_THREADS, and "Show
        // less" must be offered as soon as anything beyond the baseline shows.
        canShowLess: visibleCount > baselineCount,
      });
    }
  }

  return { items, stickyHeaderIndices };
}
