import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import {
  openPreviewSession,
  type OpenPreviewMutation,
} from "~/components/preview/openPreviewSession";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export const isMediaReferenceFile = (path: string): boolean =>
  /\.(?:html?|pdf|png|jpe?g|gif|svg|webp|avif|ico|bmp|mp4|webm|mov|mp3|wav|txt|log|json|ya?ml|toml|py|tsx?|jsx?|mdx?|rs|go|sh|css)$/i.test(
    path.split(/[?#]/, 1)[0] ?? "",
  );

export async function openFileInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly resource: {
      readonly _tag: "referenced-file";
      readonly threadId: ScopedThreadRef["threadId"];
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
    };
  }) => Promise<{ readonly relativeUrl: string }>;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E>> {
  if (!isPreviewSupportedInRuntime()) {
    throw new Error("The integrated browser is unavailable in this runtime.");
  }
  const asset = await input.createAssetUrl({
    resource: {
      _tag: "referenced-file",
      threadId: input.threadRef.threadId,
      path: input.filePath,
      ...(input.line === undefined ? {} : { line: input.line }),
      ...(input.column === undefined ? {} : { column: input.column }),
    },
  });
  let url: string;
  try {
    url = new URL(asset.relativeUrl, input.httpBaseUrl).toString();
  } catch {
    throw new Error("The environment returned an invalid asset URL.");
  }
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    url,
  });
  return mapAtomCommandResult(result, (snapshot) => {
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}
