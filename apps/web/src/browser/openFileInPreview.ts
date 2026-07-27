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

function dataUrlForFile(path: string, contents: string): string {
  const type = /\.pdf$/i.test(path) ? "application/pdf" : "text/html;charset=utf-8";
  return `data:${type};base64,${btoa(unescape(encodeURIComponent(contents)))}`;
}

export async function openFileInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly relativePath: string;
  readonly readFile: (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) => Promise<{ readonly contents: string }>;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E>> {
  if (!isPreviewSupportedInRuntime()) {
    throw new Error("The integrated browser is unavailable in this runtime.");
  }
  const file = await input.readFile({ cwd: input.cwd, relativePath: input.relativePath });
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    url: dataUrlForFile(input.relativePath, file.contents),
  });
  return mapAtomCommandResult(result, (snapshot) => {
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}
