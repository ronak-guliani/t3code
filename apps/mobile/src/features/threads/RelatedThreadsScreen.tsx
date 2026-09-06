import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useRef } from "react";
import { FlatList, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useEnvironmentServerConfig, useThreadShells } from "../../state/entities";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThreadListActions } from "../home/useThreadListActions";
import { ThreadListRow } from "./thread-list-items";
import {
  buildMobileThreadTree,
  relatedThreadRows,
  type MobileThreadTreeRow,
} from "./mobile-thread-hierarchy";
import {
  useDismissedAgentRunKeys,
  useMarkChildNotificationsRead,
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
  const serverConfig = useEnvironmentServerConfig(root?.environmentId ?? null);
  const titleRegenerationSupported =
    serverConfig?.environment.capabilities.threadTitleRegeneration === true;
  useMarkChildNotificationsRead(root, rows[0]?.latestRelatedNotificationAt);
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
    ({ item, index }: { item: MobileThreadTreeRow; index: number }) => (
      <ThreadListRow
        variant="compact"
        thread={item.thread}
        hierarchy={item}
        hideRelated
        isLast={index === rows.length - 1}
        onSelectThread={onSelectThread}
        onArchiveThread={actions.archiveThread}
        onDeleteThread={actions.confirmDeleteThread}
        onRegenerateThreadTitle={actions.regenerateThreadTitle}
        titleRegenerationSupported={titleRegenerationSupported}
        onSwipeableWillOpen={onSwipeableWillOpen}
        onSwipeableClose={onSwipeableClose}
      />
    ),
    [
      actions.archiveThread,
      actions.confirmDeleteThread,
      actions.regenerateThreadTitle,
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
