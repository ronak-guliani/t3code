import type { Preferences } from "../../persistence/mobile-preferences";
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
