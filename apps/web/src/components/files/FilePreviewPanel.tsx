import { Eye, FileText } from "lucide-react";
import { useEffect, useState } from "react";

import type { ScopedThreadRef } from "@t3tools/contracts";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { readEnvironmentApi } from "~/environmentApi";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

export function FilePreviewPanel(props: {
  readonly cwd: string;
  readonly relativePath: string | null;
  readonly threadRef: ScopedThreadRef;
  readonly onOpenFile: (relativePath: string) => void;
}) {
  const [contents, setContents] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openPreview = useAtomCommand(previewEnvironment.open);
  const api = readEnvironmentApi(props.threadRef.environmentId);

  useEffect(() => {
    if (!props.relativePath || !api) {
      setContents(null);
      setError(null);
      return;
    }
    let cancelled = false;
    void api.projects.readFile({ cwd: props.cwd, relativePath: props.relativePath }).then(
      (result) => {
        if (!cancelled) {
          setContents(result.contents);
          setError(null);
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setContents(null);
          setError(cause instanceof Error ? cause.message : "Unable to read file.");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, props.cwd, props.relativePath]);

  if (!props.relativePath) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select a workspace file to preview it.
      </div>
    );
  }

  const relativePath = props.relativePath;
  const openInBrowser =
    isPreviewSupportedInRuntime() && isBrowserPreviewFile(relativePath) && api
      ? () =>
          void openFileInPreview({
            threadRef: props.threadRef,
            cwd: props.cwd,
            relativePath,
            readFile: api.projects.readFile,
            openPreview,
          })
      : null;

  return (
    <section className="flex h-full min-h-0 flex-col" data-right-panel-file-surface>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <FileText className="size-4" />
        <span className="min-w-0 flex-1 truncate">{props.relativePath}</span>
        {openInBrowser ? (
          <button type="button" className="rounded p-1 hover:bg-accent" onClick={openInBrowser}>
            <Eye className="size-4" />
            <span className="sr-only">Open in browser</span>
          </button>
        ) : null}
      </header>
      <pre className="min-h-0 flex-1 overflow-auto p-4 text-xs">
        {error ?? contents ?? "Loading file..."}
      </pre>
    </section>
  );
}
