import type { Preferences } from "../../persistence/mobile-preferences";
import { hierarchyThreadKey } from "@t3tools/client-runtime/state/thread-hierarchy";
import {
  nestedThreadCompletionMarker,
  nestedThreadKey,
  type MobileThreadShell,
} from "./mobile-thread-hierarchy";

export function markNestedThreadRead(
  thread: MobileThreadShell,
  preferences: Pick<Preferences, "threadChildReadAt">,
  save: (patch: { readonly threadChildReadAt: Readonly<Record<string, string>> }) => void,
): void {
  const marker = nestedThreadCompletionMarker(thread);
  if (marker === null) return;
  const key = nestedThreadKey(thread);
  const previous = preferences.threadChildReadAt?.[key];
  if (previous && Date.parse(previous) >= Date.parse(marker)) return;
  save({
    threadChildReadAt: {
      ...preferences.threadChildReadAt,
      [key]: marker,
    },
  });
}

export function rootThreadCompletionMarker(thread: MobileThreadShell): string | null {
  if (thread.parentThreadId !== null || thread.virtualAgentRun !== undefined) return null;
  return thread.latestTurn?.completedAt ?? null;
}

export function markRootThreadCompletionRead(
  thread: MobileThreadShell,
  preferences: Pick<Preferences, "threadCompletionReadAt">,
  save: (patch: { readonly threadCompletionReadAt: Readonly<Record<string, string>> }) => void,
): void {
  const marker = rootThreadCompletionMarker(thread);
  if (marker === null) return;
  const key = hierarchyThreadKey(thread);
  const previous = preferences.threadCompletionReadAt?.[key];
  if (previous && Date.parse(previous) >= Date.parse(marker)) return;
  save({
    threadCompletionReadAt: {
      ...preferences.threadCompletionReadAt,
      [key]: marker,
    },
  });
}
