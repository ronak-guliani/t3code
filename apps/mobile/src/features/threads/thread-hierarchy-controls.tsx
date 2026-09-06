import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, type ReactNode } from "react";
import { AppState, Pressable, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import {
  hasUnseenChildNotification,
  hierarchyThreadKey,
} from "@t3tools/client-runtime/state/thread-hierarchy";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AppText as Text } from "../../components/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import type { MobileThreadTreeRow } from "./mobile-thread-hierarchy";
import { NO_THREAD_EXPANSION_OVERRIDES } from "./mobile-thread-hierarchy";
import { SymbolView } from "../../components/AppSymbol";

const NO_DISMISSED_RUNS: readonly string[] = [];
export function useDismissedAgentRunKeys(): readonly string[] {
  const result = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result)
    ? (result.value.dismissedAgentRunKeys ?? NO_DISMISSED_RUNS)
    : NO_DISMISSED_RUNS;
}

export function useThreadExpandedOverrides(): ReadonlyMap<string, boolean> {
  const result = useAtomValue(mobilePreferencesAtom);
  const overrides = AsyncResult.isSuccess(result)
    ? result.value.threadExpandedOverrides
    : undefined;
  return useMemo(
    () => (overrides ? new Map(Object.entries(overrides)) : NO_THREAD_EXPANSION_OVERRIDES),
    [overrides],
  );
}

export function useMarkChildNotificationsRead(thread: EnvironmentThreadShell | null) {
  const focused = useIsFocused();
  const result = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const key = thread ? hierarchyThreadKey(thread) : null;
  const notificationAt = thread?.latestChildNotificationAt;
  useEffect(() => {
    if (!focused || !key || !notificationAt || !AsyncResult.isSuccess(result)) return;
    const markRead = () => {
      if (AppState.currentState !== "active") return;
      const current = appAtomRegistry.get(mobilePreferencesAtom);
      if (
        !AsyncResult.isSuccess(current) ||
        !hasUnseenChildNotification({
          latestChildNotificationAt: notificationAt,
          lastVisitedAt: current.value.threadChildNotificationReadAt?.[key],
        })
      )
        return;
      save({
        threadChildNotificationReadAt: {
          ...current.value.threadChildNotificationReadAt,
          [key]: notificationAt,
        },
      });
    };
    markRead();
    const subscription = AppState.addEventListener("change", markRead);
    return () => subscription.remove();
  }, [focused, key, notificationAt, result, save]);
}

export function useUnreadChildNotification(thread: EnvironmentThreadShell): boolean {
  const result = useAtomValue(mobilePreferencesAtom);
  return (
    AsyncResult.isSuccess(result) &&
    hasUnseenChildNotification({
      latestChildNotificationAt: thread.latestChildNotificationAt,
      lastVisitedAt: result.value.threadChildNotificationReadAt?.[hierarchyThreadKey(thread)],
    })
  );
}

export function ChildNotificationIndicator(props: { readonly visible: boolean }) {
  return props.visible ? (
    <Text className="text-xs text-adaptive-blue-600-400">Child update</Text>
  ) : null;
}

export function ThreadHierarchyFrame(props: {
  readonly row?: MobileThreadTreeRow | undefined;
  readonly children: ReactNode;
}) {
  const save = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const preferencesLoaded = AsyncResult.isSuccess(preferences);
  const row = props.row;
  if (!row || (!row.hasChildren && row.depth === 0)) return props.children;
  return (
    <View className="flex-row items-center" style={{ paddingLeft: Math.min(row.depth, 4) * 12 }}>
      {row.hasChildren ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${row.isExpanded ? "Collapse" : "Expand"} ${row.childCount} nested chats under ${row.thread.title}`}
          accessibilityState={{ expanded: row.isExpanded, disabled: !preferencesLoaded }}
          disabled={!preferencesLoaded}
          className="min-h-11 w-11 items-center justify-center"
          onPress={() => {
            const current = appAtomRegistry.get(mobilePreferencesAtom);
            if (!AsyncResult.isSuccess(current)) return;
            save({
              threadExpandedOverrides: {
                ...current.value.threadExpandedOverrides,
                [row.threadKey]: !row.isExpanded,
              },
            });
          }}
        >
          <SymbolView
            name={row.isExpanded ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        </Pressable>
      ) : (
        <View className="w-11" />
      )}
      <View className="min-w-0 flex-1">{props.children}</View>
    </View>
  );
}
