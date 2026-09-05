import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { readLocalApi } from "~/localApi";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useRightPanelStore } from "~/rightPanelStore";
import { openPreviewSession } from "~/components/preview/openPreviewSession";

import {
  canOpenLinksInApp,
  resolveBrowserLinkTargetPreference,
  resolveLinkTarget,
} from "./browserLinkTarget";

const NO_MODIFIER = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false } as const;

export function useOpenLink(threadRef: ScopedThreadRef | null | undefined) {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  return useCallback(
    async (
      url: string,
      options: {
        readonly event?: {
          readonly metaKey: boolean;
          readonly ctrlKey: boolean;
          readonly shiftKey?: boolean;
          readonly altKey?: boolean;
        };
        readonly threadRef?: ScopedThreadRef;
      } = {},
    ) => {
      const targetThreadRef = options.threadRef ?? threadRef;
      const target = resolveLinkTarget({
        url,
        event: options.event ?? NO_MODIFIER,
        preference: await resolveBrowserLinkTargetPreference(),
        canOpenInApp: canOpenLinksInApp(Boolean(targetThreadRef)),
      });
      if (target === "app" && targetThreadRef) {
        const result = await openPreviewSession({ threadRef: targetThreadRef, url, openPreview });
        if (result._tag === "Success") {
          useRightPanelStore.getState().openBrowser(targetThreadRef, result.value.tabId);
          return;
        }
        console.error(result.cause);
      }
      const api = readLocalApi();
      if (!api) throw new Error("Link opening is unavailable.");
      await api.shell.openExternal(url);
    },
    [openPreview, threadRef],
  );
}
