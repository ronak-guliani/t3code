import type { ScopedThreadRef } from "@t3tools/contracts";

import { openPreviewSession, type OpenPreviewMutation } from "./openPreviewSession";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  canOpenLinksInApp,
  resolveBrowserLinkTargetPreference,
  resolveLinkTarget,
  isWebUrl,
} from "~/browser/browserLinkTarget";

export async function openTerminalLinkInPreview<E>(input: {
  readonly url: string;
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly fallbackToBrowser: () => void;
  readonly event?: {
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly shiftKey?: boolean;
    readonly altKey?: boolean;
  };
}): Promise<void> {
  if (!isWebUrl(input.url) || !isPreviewSupportedInRuntime()) {
    input.fallbackToBrowser();
    return;
  }
  const target = resolveLinkTarget({
    url: input.url,
    event: input.event ?? { metaKey: false, ctrlKey: false },
    preference: await resolveBrowserLinkTargetPreference(),
    canOpenInApp: canOpenLinksInApp(true),
  });
  if (target === "system") {
    input.fallbackToBrowser();
    return;
  }

  const result = await openPreviewSession({
    threadRef: input.threadRef,
    url: input.url,
    openPreview: input.openPreview,
  });
  if (result._tag === "Failure") {
    input.fallbackToBrowser();
    return;
  }
  useRightPanelStore.getState().openBrowser(input.threadRef, result.value.tabId);
}
