import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  hasUnseenChildNotification,
  hierarchyThreadKey,
} from "@t3tools/client-runtime/state/thread-hierarchy";
import type {
  EnvironmentThreadShell,
  EnvironmentShellStatus,
} from "@t3tools/client-runtime/state/shell";
import { appAtomRegistry } from "../../state/atom-registry";
import { ROOT_THREAD_COMPLETION_READ_MIGRATION_VERSION } from "../../state/thread-completion-read-migration";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useOnAppStateChange } from "../../lib/appForeground";
import type { MobileThreadShell, MobileThreadTreeRow } from "./mobile-thread-hierarchy";
import {
  markNestedThreadRead,
  markRootThreadCompletionRead,
  seedRootThreadCompletionReadAt,
} from "./nested-thread-read";

const NO_DISMISSED_RUNS: readonly string[] = [];
export function useDismissedAgentRunKeys(): readonly string[] {
  const result = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result)
    ? (result.value.dismissedAgentRunKeys ?? NO_DISMISSED_RUNS)
    : NO_DISMISSED_RUNS;
}

export function useThreadChildReadAt(): Readonly<Record<string, string>> {
  const result = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result) ? (result.value.threadChildReadAt ?? {}) : {};
}

export function useThreadCompletionReadAt(): Readonly<Record<string, string>> {
  const result = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result) ? (result.value.threadCompletionReadAt ?? {}) : {};
}

export function useSeedRootThreadCompletionReadAt(
  threads: readonly MobileThreadShell[],
  shellStatuses: ReadonlyMap<EnvironmentId, EnvironmentShellStatus>,
) {
  const result = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const migrationClaimed = useRef(false);
  useEffect(() => {
    if (
      migrationClaimed.current ||
      !AsyncResult.isSuccess(result) ||
      threads.length === 0 ||
      shellStatuses.size === 0 ||
      [...shellStatuses.values()].some((status) => status !== "live")
    ) {
      return;
    }
    const current = appAtomRegistry.get(mobilePreferencesAtom);
    if (!AsyncResult.isSuccess(current)) return;
    if (
      (current.value.threadCompletionReadAtMigrationVersion ?? 0) >=
      ROOT_THREAD_COMPLETION_READ_MIGRATION_VERSION
    ) {
      migrationClaimed.current = true;
      return;
    }
    const existing = current.value.threadCompletionReadAt;
    const seeded = seedRootThreadCompletionReadAt(threads, existing);
    migrationClaimed.current = true;
    save({
      threadCompletionReadAt: seeded ?? existing ?? {},
      threadCompletionReadAtMigrationVersion: ROOT_THREAD_COMPLETION_READ_MIGRATION_VERSION,
    });
  }, [result, save, shellStatuses, threads]);
}

export function useMarkRootThreadCompletionRead(thread: MobileThreadShell | null) {
  const focused = useIsFocused();
  const result = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  useEffect(() => {
    if (!focused || thread === null || thread.parentThreadId != null) return;
    if (AppState.currentState !== "active" || !AsyncResult.isSuccess(result)) return;
    const current = appAtomRegistry.get(mobilePreferencesAtom);
    if (!AsyncResult.isSuccess(current)) return;
    markRootThreadCompletionRead(thread, current.value, save);
  }, [focused, result, save, thread]);
  // Shared foreground subscription: all mark-read hooks reuse one global
  // AppState listener instead of registering their own (client-event-listeners).
  // Reads AppState.currentState like the immediate pass above so behavior is
  // identical on mount and on resume.
  useOnAppStateChange(() => {
    if (!focused || thread === null || thread.parentThreadId != null) {
      return;
    }
    if (AppState.currentState !== "active" || !AsyncResult.isSuccess(result)) return;
    const current = appAtomRegistry.get(mobilePreferencesAtom);
    if (!AsyncResult.isSuccess(current)) return;
    markRootThreadCompletionRead(thread, current.value, save);
  });
}

export function useMarkNestedThreadRead(thread: MobileThreadShell | null) {
  const focused = useIsFocused();
  const result = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  useEffect(() => {
    if (!focused || thread === null || thread.parentThreadId == null) return;
    if (AppState.currentState !== "active" || !AsyncResult.isSuccess(result)) return;
    const current = appAtomRegistry.get(mobilePreferencesAtom);
    if (!AsyncResult.isSuccess(current)) return;
    markNestedThreadRead(thread, current.value, save);
  }, [focused, result, save, thread]);
  useOnAppStateChange(() => {
    if (!focused || thread === null || thread.parentThreadId == null) {
      return;
    }
    if (AppState.currentState !== "active" || !AsyncResult.isSuccess(result)) return;
    const current = appAtomRegistry.get(mobilePreferencesAtom);
    if (!AsyncResult.isSuccess(current)) return;
    markNestedThreadRead(thread, current.value, save);
  });
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
  }, [focused, stamps, result, save]);
  useOnAppStateChange(() => {
    if (!focused || stamps.length === 0 || !AsyncResult.isSuccess(result)) {
      return;
    }
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
  });
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
