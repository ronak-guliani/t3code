import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import {
  hasUnseenChildNotification,
  hierarchyThreadKey,
} from "@t3tools/client-runtime/state/thread-hierarchy";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const NO_DISMISSED_RUNS: readonly string[] = [];
export function useDismissedAgentRunKeys(): readonly string[] {
  const result = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result)
    ? (result.value.dismissedAgentRunKeys ?? NO_DISMISSED_RUNS)
    : NO_DISMISSED_RUNS;
}

export function useMarkChildNotificationsRead(
  thread: EnvironmentThreadShell | null,
  notificationAt = thread?.latestChildNotificationAt,
) {
  const focused = useIsFocused();
  const result = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const key = thread ? hierarchyThreadKey(thread) : null;
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

export function useUnreadChildNotification(
  thread: EnvironmentThreadShell,
  notificationAt = thread.latestChildNotificationAt,
): boolean {
  const result = useAtomValue(mobilePreferencesAtom);
  return (
    AsyncResult.isSuccess(result) &&
    hasUnseenChildNotification({
      latestChildNotificationAt: notificationAt,
      lastVisitedAt: result.value.threadChildNotificationReadAt?.[hierarchyThreadKey(thread)],
    })
  );
}
