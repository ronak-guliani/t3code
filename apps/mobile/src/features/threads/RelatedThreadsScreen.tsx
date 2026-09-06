import { type StaticScreenProps, useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThreadListActions } from "../home/useThreadListActions";
import { ThreadListRow } from "./thread-list-items";
import { ThreadListV2Row } from "./thread-list-v2-items";
import { snoozeWakeLabel } from "./threadListV2";
import { useThreadListV2Enabled } from "./use-thread-list-v2-enabled";
import {
  buildMobileThreadTree,
  relatedThreadRows,
  type MobileThreadTreeRow,
} from "./mobile-thread-hierarchy";
import {
  useDismissedAgentRunKeys,
  useMarkThreadGroupNotificationsRead,
} from "./thread-hierarchy-controls";

export function RelatedThreadsScreen(
  props: StaticScreenProps<{
    readonly environmentId: string;
    readonly threadId: string;
  }>,
) {
  const navigation = useNavigation();
  const threads = useThreadShells();
  const dismissed = useDismissedAgentRunKeys();
  const { environmentId, threadId } = props.route.params;
  const rows = useMemo(() => {
    const tree = buildMobileThreadTree(
      threads.filter((thread) => thread.environmentId === environmentId),
      undefined,
      dismissed,
    );
    return relatedThreadRows(tree, `${environmentId}:${threadId}`);
  }, [dismissed, environmentId, threadId, threads]);
  const root = rows[0]?.thread ?? null;
  const serverConfigs = useServerConfigs();
  const capabilities = root
    ? serverConfigs.get(root.environmentId)?.environment.capabilities
    : undefined;
  const titleRegenerationSupported = capabilities?.threadTitleRegeneration === true;
  const settlementSupported = capabilities?.threadSettlement === true;
  const snoozeSupported = capabilities?.threadSnooze === true;
  const pinningSupported = capabilities?.threadPinning === true;
  const pinReorderSupported = capabilities?.threadPinReorder === true;
  const threadListV2Enabled = useThreadListV2Enabled();
  const [now, setNow] = useState(() => new Date().toISOString());
  useFocusEffect(
    useCallback(() => {
      if (!threadListV2Enabled) return;
      const refresh = () => setNow(new Date().toISOString());
      refresh();
      const timer = setInterval(refresh, 60_000);
      return () => clearInterval(timer);
    }, [threadListV2Enabled]),
  );
  const rootState = useMemo(
    () => ({
      variant: "card" as const,
      snoozed: root !== null && snoozeSupported && root.snoozedUntil !== null,
      pinned: root?.pinnedAt != null,
    }),
    [root, snoozeSupported],
  );
  const wakeAt = rootState.snoozed ? root?.snoozedUntil : null;
  useEffect(() => {
    if (!threadListV2Enabled || !wakeAt) return;
    const delay = Math.min(Math.max(0, Date.parse(wakeAt) - Date.now()) + 50, 2_147_483_647);
    const timer = setTimeout(() => setNow(new Date().toISOString()), delay);
    return () => clearTimeout(timer);
  }, [threadListV2Enabled, wakeAt, now]);
  const pinnedKeys = useMemo(
    () =>
      sortPinnedThreadsByOrderKey(
        threads.filter(
          (thread) =>
            thread.pinnedAt != null &&
            thread.archivedAt === null &&
            serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinReorder ===
              true,
        ),
      ).map((thread) => `${thread.environmentId}:${thread.id}`),
    [threads, serverConfigs],
  );
  const pinIndex = pinnedKeys.indexOf(`${environmentId}:${threadId}`);
  useMarkThreadGroupNotificationsRead(rows);
  const actions = useThreadListActions();
  const swipeable = useRef<SwipeableMethods | null>(null);
  const onSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (swipeable.current !== methods) swipeable.current?.close();
    swipeable.current = methods;
  }, []);
  const onSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (swipeable.current === methods) swipeable.current = null;
  }, []);
  const onSelectThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      navigation.navigate("Thread", { environmentId: thread.environmentId, threadId: thread.id });
    },
    [navigation],
  );
  const renderItem = useCallback(
    ({ item, index }: { item: MobileThreadTreeRow; index: number }) => {
      if (threadListV2Enabled) {
        const state =
          index === 0 ? rootState : { variant: "card" as const, snoozed: false, pinned: false };
        return (
          <ThreadListV2Row
            thread={item.thread}
            {...state}
            project={null}
            providerDriver={null}
            environmentLabel={null}
            snoozePresetMinute={now.slice(0, 16)}
            snoozeWakeLabelText={
              state.snoozed && item.thread.snoozedUntil
                ? snoozeWakeLabel(item.thread.snoozedUntil, { now })
                : undefined
            }
            showTrailingDivider={index !== rows.length - 1}
            onSelectThread={onSelectThread}
            onArchiveThread={actions.archiveThread}
            onDeleteThread={actions.confirmDeleteThread}
            onRegenerateThreadTitle={actions.regenerateThreadTitle}
            onSettleThread={actions.settleThread}
            onUnsettleThread={actions.unsettleThread}
            onSnoozeThread={actions.snoozeThread}
            onUnsnoozeThread={actions.unsnoozeThread}
            onPinThread={actions.pinThread}
            onUnpinThread={actions.unpinThread}
            onMoveThread={actions.moveThread}
            settlementSupported={settlementSupported}
            snoozeSupported={snoozeSupported}
            pinningSupported={pinningSupported}
            reorderSupported={pinReorderSupported}
            canMoveUp={pinIndex > 0}
            canMoveDown={pinIndex >= 0 && pinIndex < pinnedKeys.length - 1}
            titleRegenerationSupported={titleRegenerationSupported}
            onSwipeableWillOpen={onSwipeableWillOpen}
            onSwipeableClose={onSwipeableClose}
          />
        );
      }
      return (
        <ThreadListRow
          variant="compact"
          thread={item.thread}
          environmentLabel={null}
          isLast={index === rows.length - 1}
          onSelectThread={onSelectThread}
          onArchiveThread={actions.archiveThread}
          onDeleteThread={actions.confirmDeleteThread}
          onRegenerateThreadTitle={actions.regenerateThreadTitle}
          titleRegenerationSupported={titleRegenerationSupported}
          onSwipeableWillOpen={onSwipeableWillOpen}
          onSwipeableClose={onSwipeableClose}
        />
      );
    },
    [
      actions.archiveThread,
      actions.confirmDeleteThread,
      actions.regenerateThreadTitle,
      actions.settleThread,
      actions.unsettleThread,
      actions.snoozeThread,
      actions.unsnoozeThread,
      actions.pinThread,
      actions.unpinThread,
      actions.moveThread,
      threadListV2Enabled,
      rootState,
      now,
      settlementSupported,
      snoozeSupported,
      pinningSupported,
      pinReorderSupported,
      pinIndex,
      pinnedKeys.length,
      onSelectThread,
      onSwipeableClose,
      onSwipeableWillOpen,
      rows.length,
      titleRegenerationSupported,
    ],
  );
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title: "Related chats" }} />
      <FlatList
        data={rows}
        renderItem={renderItem}
        keyExtractor={(row) => row.threadKey}
        contentInsetAdjustmentBehavior="automatic"
        ListHeaderComponent={
          root ? (
            <View className="gap-1 px-5 pb-3 pt-4">
              <Text className="text-lg font-t3-medium text-foreground">{root.title}</Text>
              <Text className="text-sm text-foreground-muted">
                {rows.length} {rows.length === 1 ? "chat" : "chats"} in this group
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <EmptyState
            title="Group unavailable"
            detail="This chat was archived or deleted. Return to the inbox to choose another chat."
          />
        }
      />
    </View>
  );
}
