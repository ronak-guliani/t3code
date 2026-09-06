import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import {
  hasUnseenChildNotification,
  hierarchyThreadKey,
} from "@t3tools/client-runtime/state/thread-hierarchy";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import type { MobileThreadTreeRow } from "./mobile-thread-hierarchy";

const NO_DISMISSED_RUNS: readonly string[] = [];
export function useDismissedAgentRunKeys(): readonly string[] {
  const result = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result)
    ? (result.value.dismissedAgentRunKeys ?? NO_DISMISSED_RUNS)
    : NO_DISMISSED_RUNS;
}

type NotificationStamp = {
  readonly threadKey: string;
  readonly notificationAt: string | null | undefined;
};

export function useMarkChildNotificationsRead(thread: EnvironmentThreadShell | null) {
  const threadKey = thread ? hierarchyThreadKey(thread) : null;
  const notificationAt = thread?.latestChildNotificationAt;
  const stamps = useMemo(
    () => (threadKey ? [{ threadKey, notificationAt }] : []),
    [threadKey, notificationAt],
  );
  useMarkNotificationsRead(stamps);
}

export function useMarkThreadGroupNotificationsRead(
  rows: readonly Pick<MobileThreadTreeRow, "threadKey" | "latestRelatedNotificationAt">[],
) {
  const stamps = useMemo(
    () =>
      rows.map((row) => ({
        threadKey: row.threadKey,
        notificationAt: row.latestRelatedNotificationAt,
      })),
    [rows],
  );
  useMarkNotificationsRead(stamps);
}

function useMarkNotificationsRead(stamps: readonly NotificationStamp[]) {
  const focused = useIsFocused();
  const result = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  useEffect(() => {
    if (!focused || stamps.length === 0 || !AsyncResult.isSuccess(result)) return;
    const markRead = () => {
      if (AppState.currentState !== "active") return;
      const current = appAtomRegistry.get(mobilePreferencesAtom);
      if (!AsyncResult.isSuccess(current)) return;
      let readAt: Record<string, string> | undefined;
      for (const { threadKey, notificationAt } of stamps) {
        if (
          notificationAt &&
          hasUnseenChildNotification({
            latestChildNotificationAt: notificationAt,
            lastVisitedAt:
              readAt?.[threadKey] ?? current.value.threadChildNotificationReadAt?.[threadKey],
          })
        ) {
          readAt ??= { ...current.value.threadChildNotificationReadAt };
          readAt[threadKey] = notificationAt;
        }
      }
      if (readAt) save({ threadChildNotificationReadAt: readAt });
    };
    markRead();
    const subscription = AppState.addEventListener("change", markRead);
    return () => subscription.remove();
  }, [focused, stamps, result, save]);
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
