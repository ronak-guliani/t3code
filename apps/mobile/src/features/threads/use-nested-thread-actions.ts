import { useAppNavigation } from "../../lib/use-app-navigation";
import type { MenuAction } from "@react-native-menu/menu";
import type { MobileThreadShell } from "./mobile-thread-hierarchy";
import * as Cause from "effect/Cause";
import { useCallback, useMemo, useRef } from "react";
import { Alert } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomSet } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useNestedThreadActions(thread: MobileThreadShell) {
  const navigation = useAppNavigation();
  const decouple = useAtomCommand(threadEnvironment.decouple, { reportFailure: false });
  const pending = useRef(false);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const dismissAgentRun = useCallback(() => {
    if (!thread.virtualAgentRun) return;
    if (thread.virtualAgentRun.status === "running") {
      Alert.alert("Agent is running", "Open the parent chat to follow or interrupt its work.");
      return;
    }
    const preferences = appAtomRegistry.get(mobilePreferencesAtom);
    if (!AsyncResult.isSuccess(preferences)) {
      Alert.alert("Preferences are loading", "Try archiving this agent again in a moment.");
      return;
    }
    const key = `${thread.environmentId}:${thread.id}`;
    savePreferences({
      dismissedAgentRunKeys: [
        ...new Set([...(preferences.value.dismissedAgentRunKeys ?? []), key]),
      ],
    });
  }, [savePreferences, thread.environmentId, thread.id, thread.virtualAgentRun]);
  const createSubchat = useCallback(() => {
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        parentThreadId: thread.id,
        title: "New subchat",
      },
    });
  }, [navigation, thread.environmentId, thread.id, thread.projectId]);
  const openParent = useCallback(() => {
    const parentThreadId = thread.parentThreadId;
    const parent =
      parentThreadId == null
        ? null
        : appAtomRegistry.get(
            environmentThreadShells.threadShellAtom({
              environmentId: thread.environmentId,
              threadId: parentThreadId,
            }),
          );
    if (!parent || parent.archivedAt !== null) {
      Alert.alert(
        "Parent chat unavailable",
        "The parent chat was archived or deleted. Archived chats can be restored from Settings.",
      );
      return;
    }
    navigation.navigate("Thread", { environmentId: thread.environmentId, threadId: parent.id });
  }, [navigation, thread.environmentId, thread.parentThreadId]);
  const decoupleChat = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      const result = await decouple({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not decouple chat",
          error instanceof Error ? error.message : "Try again when the environment is connected.",
        );
      }
    } finally {
      pending.current = false;
    }
  }, [decouple, thread.environmentId, thread.id]);
  const actions = useMemo<Array<MenuAction & { readonly id: string }>>(
    () =>
      thread.virtualAgentRun
        ? [
            { id: "open-parent", title: "Open parent chat", image: "arrow.turn.up.left" },
            ...(thread.virtualAgentRun.status === "running"
              ? []
              : [{ id: "dismiss-agent-run", title: "Archive", image: "archivebox" }]),
          ]
        : [
            { id: "new-subchat", title: "New subchat", image: "plus.bubble" },
            ...(thread.parentThreadId == null
              ? []
              : [
                  { id: "open-parent", title: "Go to parent chat", image: "arrow.turn.up.left" },
                  { id: "decouple", title: "Decouple chat", image: "arrow.up.right" },
                ]),
          ],
    [thread.parentThreadId, thread.virtualAgentRun],
  );
  const handleAction = useCallback(
    (event: string) => {
      if (event === "new-subchat") createSubchat();
      if (event === "open-parent") openParent();
      if (event === "decouple") void decoupleChat();
      if (event === "dismiss-agent-run") dismissAgentRun();
    },
    [createSubchat, openParent, decoupleChat, dismissAgentRun],
  );
  return { actions, handleAction, createSubchat, openParent, dismissAgentRun };
}
