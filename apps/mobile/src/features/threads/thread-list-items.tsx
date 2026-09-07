import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useMemo, type ComponentProps } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { HOME_HORIZONTAL_INSET } from "../../lib/layoutMetrics";
import { relativeTime } from "../../lib/time";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import type { HomeGroupDisplayAction } from "../home/homeListItems";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { CompactThreadRow } from "./compact-thread-row";
import {
  resolveNestedThreadStatus,
  type MobileThreadTreeRow,
  type MobileThreadShell,
} from "./mobile-thread-hierarchy";
import { useNestedThreadActions } from "./use-nested-thread-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import { resolveThreadStatus } from "./threadPresentation";

export type ThreadListVariant = "compact" | "sidebar";
export const THREAD_LIST_COMPACT_INSET = HOME_HORIZONTAL_INSET;

export const ThreadListGroupHeader = memo(function ThreadListGroupHeader(props: {
  readonly variant: ThreadListVariant;
  readonly project: EnvironmentProject;
  readonly title: string;
  readonly threadCount: number;
  readonly collapsed: boolean;
  readonly isFirst: boolean;
  readonly groupKey: string;
  readonly onGroupAction: (key: string, action: HomeGroupDisplayAction) => void;
  readonly newThreadTarget?: EnvironmentProject | null;
  readonly onNewThread?: (project: EnvironmentProject) => void;
}) {
  const compact = props.variant === "compact";
  return (
    <View
      className={compact ? "flex-row items-center bg-screen" : "flex-row items-center"}
      style={{ paddingHorizontal: compact ? 18 : 12, paddingTop: props.isFirst ? 0 : 12 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        accessibilityLabel={`${props.title}, ${props.threadCount} threads`}
        accessibilityHint={props.collapsed ? "Expands the project" : "Collapses the project"}
        className="min-h-11 flex-1 flex-row items-center gap-2"
        onPress={() => props.onGroupAction(props.groupKey, "toggle-collapsed")}
      >
        <ProjectFavicon
          environmentId={props.project.environmentId}
          faviconPath={props.project.faviconPath}
          open={!props.collapsed}
          size={16}
          projectTitle={props.project.title}
          workspaceRoot={props.project.workspaceRoot}
        />
        <Text className="shrink text-xs font-t3-bold text-foreground-muted" numberOfLines={1}>
          {props.title}
        </Text>
        <Text className="text-xs tabular-nums text-foreground-tertiary">{props.threadCount}</Text>
      </Pressable>
      {props.onNewThread && props.newThreadTarget ? (
        <Pressable
          accessibilityLabel={`Create new thread in ${props.title}`}
          accessibilityRole="button"
          className="min-h-11 w-11 items-center justify-center"
          onPress={() => {
            if (props.newThreadTarget) props.onNewThread?.(props.newThreadTarget);
          }}
        >
          <SymbolView name="plus" size={16} tintColorClassName="accent-icon-muted" />
        </Pressable>
      ) : null}
    </View>
  );
});

export const ThreadListShowMoreRow = memo(function ThreadListShowMoreRow(props: {
  readonly variant: ThreadListVariant;
  readonly hiddenCount: number;
  readonly canShowLess: boolean;
  readonly groupKey: string;
  readonly onGroupAction: (key: string, action: HomeGroupDisplayAction) => void;
}) {
  return (
    <View
      className="flex-row items-center gap-4"
      style={{ paddingHorizontal: props.variant === "compact" ? 38 : 32 }}
    >
      {props.hiddenCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show more threads"
          className="min-h-11 justify-center"
          onPress={() => props.onGroupAction(props.groupKey, "show-more")}
        >
          <Text className="text-xs font-t3-medium text-foreground-muted">
            Show more ({props.hiddenCount})
          </Text>
        </Pressable>
      ) : null}
      {props.canShowLess ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show fewer threads"
          className="min-h-11 justify-center"
          onPress={() => props.onGroupAction(props.groupKey, "show-less")}
        >
          <Text className="text-xs font-t3-medium text-foreground-muted">Show less</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

export const PendingTaskListRow = memo(function PendingTaskListRow(props: {
  readonly variant: ThreadListVariant;
  readonly pendingTask: PendingNewTask;
  readonly isLast: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}) {
  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );
  return (
    <CompactThreadRow
      menu={{ actions: PENDING_TASK_MENU_ACTIONS, onPressAction: handleMenuAction }}
      title={pendingTask.title}
      timestamp={relativeTime(pendingTask.message.createdAt)}
      status="queued"
      sidebar={props.variant === "sidebar"}
      showDivider={!props.isLast}
      accessibilityHint="Opens the queued task for editing"
      onPress={() => onSelectPendingTask(pendingTask)}
    />
  );
});

export const ThreadListRow = memo(function ThreadListRow(props: {
  readonly variant: ThreadListVariant;
  readonly thread: MobileThreadShell;
  readonly hierarchy?: MobileThreadTreeRow | undefined;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  readonly isLast: boolean;
  readonly selected?: boolean;
  readonly hideRelated?: boolean;
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly titleRegenerationSupported: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
}) {
  const { width } = useWindowDimensions();
  const theme = useUniwindTheme();
  const { thread, onSelectThread, onArchiveThread, onDeleteThread, onRegenerateThreadTitle } =
    props;
  const nesting = useNestedThreadActions(thread);
  const handleDelete = useCallback(
    () => (thread.virtualAgentRun ? nesting.dismissAgentRun() : onDeleteThread(thread)),
    [nesting.dismissAgentRun, onDeleteThread, thread],
  );
  const handleArchive = useCallback(
    () => (thread.virtualAgentRun ? nesting.dismissAgentRun() : onArchiveThread(thread)),
    [nesting.dismissAgentRun, onArchiveThread, thread],
  );
  const handleSelect = useCallback(
    () => (thread.virtualAgentRun ? nesting.openParent() : onSelectThread(thread)),
    [nesting.openParent, onSelectThread, thread],
  );
  const menuActions = useMemo<MenuAction[]>(
    () => [
      ...nesting.actions,
      ...(thread.virtualAgentRun
        ? []
        : [
            {
              id: "archive",
              title: "Archive",
              image: "archivebox",
              attributes: { disabled: props.hierarchy?.archiveBlocked === true },
            },
            ...buildThreadTitleRegenerationMenuItems({
              supported: props.titleRegenerationSupported,
              isRegenerating: thread.titleRegeneration != null,
            }),
            { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
          ]),
    ],
    [
      nesting.actions,
      props.hierarchy?.archiveBlocked,
      props.titleRegenerationSupported,
      thread.titleRegeneration,
      thread.virtualAgentRun,
    ],
  );
  const primaryAction = useMemo(
    () => ({
      accessibilityLabel: `Archive ${thread.title}`,
      icon: "archivebox" as const,
      label: "Archive",
      onPress: handleArchive,
    }),
    [handleArchive, thread.title],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      nesting.handleAction(nativeEvent.event);
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "regenerate-title") onRegenerateThreadTitle(thread);
      if (nativeEvent.event === "delete") handleDelete();
    },
    [nesting.handleAction, handleArchive, handleDelete, onRegenerateThreadTitle, thread],
  );
  const ownStatus = resolveNestedThreadStatus(thread);
  const status =
    ownStatus === "ready" && resolveThreadStatus(thread)?.kind === "plan-ready"
      ? "plan-ready"
      : ownStatus;
  return (
    <ThreadSwipeable
      backgroundColor={
        props.variant === "compact" ? theme["--color-screen"] : theme["--color-drawer"]
      }
      compactActions
      enableTrackpadSwipe
      fullSwipeWidth={props.fullSwipeWidth ?? width - 32}
      onDelete={handleDelete}
      onSwipeableClose={props.onSwipeableClose}
      onSwipeableWillOpen={props.onSwipeableWillOpen}
      primaryAction={primaryAction}
      resetKey={`${thread.environmentId}:${thread.id}`}
      simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
      threadTitle={thread.title}
    >
      {(close) => (
        <CompactThreadRow
          menu={{ actions: menuActions, onPressAction: handleMenuAction }}
          title={thread.title}
          timestamp={relativeTime(
            thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
          )}
          status={status}
          sidebar={props.variant === "sidebar"}
          selected={props.selected}
          showDivider={!props.isLast}
          related={props.hideRelated ? undefined : { thread, hierarchy: props.hierarchy }}
          searchMatch={props.searchMatch}
          searchQuery={props.searchQuery}
          accessibilityHint="Opens the thread. Swipe left for archive and delete actions."
          onPress={() => {
            close();
            handleSelect();
          }}
        />
      )}
    </ThreadSwipeable>
  );
});
