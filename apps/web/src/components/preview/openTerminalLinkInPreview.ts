import type { LocalApi, ScopedThreadRef } from "@t3tools/contracts";
import { isPreviewableUrl } from "@t3tools/shared/preview";

import type { OpenPreviewMutation } from "./openPreviewSession";
import { applyPreviewServerSnapshot, isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  canOpenLinksInApp,
  resolveBrowserLinkTargetPreference,
  resolveLinkTarget,
} from "~/browser/browserLinkTarget";

export async function openTerminalLinkInPreview<E>(input: {
  readonly url: string;
  readonly position: { x: number; y: number };
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly localApi: LocalApi;
  readonly fallbackToBrowser: () => void;
  readonly event?: {
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly shiftKey?: boolean;
    readonly altKey?: boolean;
  };
}): Promise<void> {
  if (!isPreviewableUrl(input.url) || !isPreviewSupportedInRuntime()) {
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

  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: { threadId: input.threadRef.threadId, url: input.url },
  });
  if (result._tag === "Failure") {
    input.fallbackToBrowser();
    return;
  }
  applyPreviewServerSnapshot(input.threadRef, result.value);
  useRightPanelStore.getState().openBrowser(input.threadRef, result.value.tabId);
}
