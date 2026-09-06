import type { ScopedThreadRef } from "@t3tools/contracts";
import { Editor } from "@pierre/diffs/editor";
import { EditorProvider, File, Virtualizer } from "@pierre/diffs/react";
import { BookOpen, ChevronRight, Code2, Eye, FolderTree, LoaderCircle } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { ensureEnvironmentApi } from "~/environmentApi";
import { getEnvironmentHttpBaseUrl } from "~/environments/runtime";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import FileBrowserPanel from "./FileBrowserPanel";
import { projectFileCacheKey } from "./fileContentRevision";
import { fileBreadcrumbs } from "./filePath";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  getProjectEntriesQueryAtom,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "./projectFilesQueryState";

const ChatMarkdown = lazy(() => import("~/components/ChatMarkdown"));

interface FilePreviewPanelProps {
  cwd: string;
  projectName?: string | undefined;
  relativePath: string | null;
  threadRef: ScopedThreadRef;
  revealLine?: number | null;
  onOpenFile: (relativePath: string) => void;
  onPendingChange?: (relativePath: string, pending: boolean) => void;
}

const FILE_EXPLORER_STORAGE_KEY = "t3code.fileExplorerOpen";
const FILE_SAVE_DEBOUNCE_MS = 500;
const NOOP_PENDING_CHANGE = () => {};

function stripQueryAndFragment(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? "";
}

function isImagePreviewFile(path: string): boolean {
  return /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i.test(stripQueryAndFragment(path));
}

function isPdfPreviewFile(path: string): boolean {
  return /\.pdf$/i.test(stripQueryAndFragment(path));
}

function isMarkdownPreviewFile(path: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(stripQueryAndFragment(path));
}

interface EditableFileSurfaceProps {
  environmentId: ScopedThreadRef["environmentId"];
  cwd: string;
  relativePath: string;
  contents: string;
  resolvedTheme: "light" | "dark";
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

function formatSaveError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unable to save file.";
}

function EditableFileSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  resolvedTheme,
  onPendingChange,
}: EditableFileSurfaceProps) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveCoordinator = useMemo(
    () =>
      new FileSaveCoordinator({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        onPendingChange: (pending) => onPendingChange(relativePath, pending),
        persist: async (nextContents) => {
          await ensureEnvironmentApi(environmentId).projects.writeFile({
            cwd,
            relativePath,
            contents: nextContents,
          });
        },
        onConfirmed: (confirmedContents) => {
          confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents);
          // Writes can create parent directories; refresh the tree listing.
          appAtomRegistry.refresh(getProjectEntriesQueryAtom(environmentId, cwd));
        },
        onError: (cause) => setSaveError(cause === null ? null : formatSaveError(cause)),
      }),
    [cwd, environmentId, onPendingChange, relativePath],
  );
  const editor = useMemo(
    () =>
      new Editor({
        onChange: (file) => {
          setProjectFileQueryData(environmentId, cwd, relativePath, file.contents);
          saveCoordinator.change(file.contents);
        },
      }),
    [cwd, environmentId, relativePath, saveCoordinator],
  );

  useEffect(
    () => () => {
      editor.cleanUp();
      saveCoordinator.dispose();
    },
    [editor, saveCoordinator],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {saveError ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/8 px-3 py-1.5 text-[11px] text-destructive">
          <span className="min-w-0 flex-1 truncate">Save failed: {saveError}</span>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-1 font-medium hover:bg-destructive/10"
            onClick={() => saveCoordinator.retry()}
          >
            Retry
          </button>
        </div>
      ) : null}
      <EditorProvider editor={editor}>
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{
            overscrollSize: 600,
            intersectionObserverMargin: 1200,
          }}
        >
          <File
            file={{
              name: relativePath,
              contents,
              cacheKey: projectFileCacheKey(cwd, relativePath, contents),
            }}
            options={{
              disableFileHeader: true,
              overflow: "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              themeType: resolvedTheme,
            }}
            className="min-h-full"
            contentEditable
          />
        </Virtualizer>
      </EditorProvider>
    </div>
  );
}

type AssetUrlFactory = (input: {
  readonly resource: {
    readonly _tag: "workspace-file";
    readonly threadId: ScopedThreadRef["threadId"];
    readonly path: string;
  };
}) => Promise<{ readonly relativeUrl: string }>;

function useWorkspaceFileUrl(
  threadId: ScopedThreadRef["threadId"],
  relativePath: string | null,
  httpBaseUrl: string | null,
  createAssetUrl: AssetUrlFactory,
  enabled: boolean,
): { url: string | null; failed: boolean; pending: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || !relativePath || !httpBaseUrl) {
      setUrl(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    void createAssetUrl({
      resource: { _tag: "workspace-file", threadId, path: relativePath },
    }).then(
      (asset) => {
        if (cancelled) return;
        try {
          setUrl(new URL(asset.relativeUrl, httpBaseUrl).toString());
        } catch {
          setFailed(true);
        }
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [createAssetUrl, enabled, httpBaseUrl, relativePath, threadId]);
  return { url, failed, pending: enabled && !!relativePath && !!httpBaseUrl && !url && !failed };
}

function WorkspaceImagePreview(props: {
  threadId: ScopedThreadRef["threadId"];
  relativePath: string;
  httpBaseUrl: string | null;
  createAssetUrl: AssetUrlFactory;
}) {
  const { url, failed, pending } = useWorkspaceFileUrl(
    props.threadId,
    props.relativePath,
    props.httpBaseUrl,
    props.createAssetUrl,
    true,
  );
  if (failed || !props.httpBaseUrl) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load image.
      </div>
    );
  }
  if (pending || !url) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        className="max-h-full max-w-full object-contain"
        src={url}
        alt={props.relativePath}
        onError={(event) => {
          event.currentTarget.style.display = "none";
        }}
      />
    </div>
  );
}

function WorkspacePdfPreview(props: {
  threadId: ScopedThreadRef["threadId"];
  relativePath: string;
  httpBaseUrl: string | null;
  createAssetUrl: AssetUrlFactory;
}) {
  const { url, failed, pending } = useWorkspaceFileUrl(
    props.threadId,
    props.relativePath,
    props.httpBaseUrl,
    props.createAssetUrl,
    true,
  );
  if (failed || !props.httpBaseUrl) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load PDF.
      </div>
    );
  }
  if (pending || !url) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }
  // The built-in PDF viewer needs an unsandboxed frame; a PDF runs no scripts.
  return (
    <iframe
      key={url}
      src={url}
      title={props.relativePath}
      className="min-h-0 flex-1 border-0 bg-white"
    />
  );
}

function initialExplorerOpen(): boolean {
  try {
    return window.localStorage.getItem(FILE_EXPLORER_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function FilePreviewPanel({
  threadRef,
  cwd,
  projectName: projectNameProp,
  relativePath,
  revealLine = null,
  onOpenFile,
  onPendingChange = NOOP_PENDING_CHANGE,
}: FilePreviewPanelProps) {
  const environmentId = threadRef.environmentId;
  const projectName = projectNameProp ?? cwd.split(/[\\/]/).findLast(Boolean) ?? cwd;
  const { resolvedTheme } = useTheme();
  const file = useProjectFileQuery(environmentId, cwd, relativePath);
  const openPreview = useAtomCommand(previewEnvironment.open);
  const environmentApi = ensureEnvironmentApi(environmentId);
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [treeReveal, setTreeReveal] = useState<{ path: string; nonce: number } | null>(null);
  const revealNonceRef = useRef(0);
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const previewBodyRef = useRef<HTMLDivElement>(null);
  const breadcrumbs = useMemo(
    () => (relativePath ? fileBreadcrumbs(projectName, relativePath) : []),
    [projectName, relativePath],
  );

  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      "[data-current-file-crumb='true']",
    );
    currentCrumb?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [relativePath]);

  // Best-effort jump to a chat-linked line. Row markup may not expose line
  // numbers, so this silently no-ops when nothing matches (bounded retries).
  useEffect(() => {
    if (
      revealLine == null ||
      !relativePath ||
      !file.data ||
      file.data.binary ||
      file.data.truncated
    ) {
      return;
    }
    let cancelled = false;
    let attempts = 0;
    const attempt = () => {
      if (cancelled) return;
      const root = previewBodyRef.current;
      const row = root?.querySelector(
        `[data-line="${revealLine}"],[data-line-number="${revealLine}"]`,
      );
      if (row) {
        (row as HTMLElement).scrollIntoView({ block: "center" });
        return;
      }
      attempts += 1;
      if (attempts < 10) requestAnimationFrame(attempt);
    };
    const frame = requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [file.data, relativePath, revealLine]);

  const setExplorerOpenPersisted = (open: boolean) => {
    setExplorerOpen(open);
    try {
      window.localStorage.setItem(FILE_EXPLORER_STORAGE_KEY, String(open));
    } catch {}
  };

  const toggleExplorer = () => {
    setExplorerOpenPersisted(!explorerOpen);
  };

  const revealInTree = (path: string) => {
    if (!path) {
      setExplorerOpenPersisted(true);
      return;
    }
    setExplorerOpenPersisted(true);
    revealNonceRef.current += 1;
    setTreeReveal({ path, nonce: revealNonceRef.current });
  };

  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  };

  const httpBaseUrl = getEnvironmentHttpBaseUrl(environmentId);
  const showImage = !!relativePath && isImagePreviewFile(relativePath);
  const showPdf = !!relativePath && !showImage && isPdfPreviewFile(relativePath);
  const showMarkdownToggle =
    !!relativePath && !showImage && !showPdf && isMarkdownPreviewFile(relativePath);
  const openInBrowser =
    relativePath &&
    isPreviewSupportedInRuntime() &&
    isBrowserPreviewFile(relativePath) &&
    httpBaseUrl
      ? () =>
          void openFileInPreview({
            threadRef,
            relativePath,
            httpBaseUrl,
            createAssetUrl: environmentApi.assets.createUrl,
            openPreview,
          })
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {relativePath ? (
        <div className="flex h-11 shrink-0 items-center gap-2 border-y border-border/60 px-3">
          <ScrollArea
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1 rounded-none"
            data-file-breadcrumbs
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              {breadcrumbs.map((crumb, index) => (
                <div
                  key={crumb.path || "project"}
                  className="flex min-w-0 shrink-0 items-center"
                  data-current-file-crumb={crumb.kind === "file"}
                >
                  {index > 0 ? (
                    <ChevronRight className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
                  ) : null}
                  {crumb.kind === "file" ? (
                    <button
                      type="button"
                      className="max-w-40 truncate font-medium text-foreground hover:underline"
                      title={`Copy path: ${relativePath}`}
                      aria-label={`Copy path ${relativePath}`}
                      onClick={() => copyText(relativePath)}
                    >
                      {crumb.label}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="max-w-40 truncate text-muted-foreground hover:text-foreground hover:underline"
                      title={crumb.path ? `Reveal ${crumb.path} in explorer` : "Show explorer"}
                      aria-label={crumb.path ? `Reveal ${crumb.path} in explorer` : "Show explorer"}
                      onClick={() => revealInTree(crumb.path)}
                    >
                      {crumb.label}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
          {showMarkdownToggle ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={renderMarkdown}
                    onPressedChange={setRenderMarkdown}
                    aria-label={renderMarkdown ? "Show markdown source" : "Show rendered markdown"}
                    variant="default"
                    size="sm"
                  >
                    {renderMarkdown ? (
                      <Code2 className="size-3.5" />
                    ) : (
                      <BookOpen className="size-3.5" />
                    )}
                  </Toggle>
                }
              />
              <TooltipPopup>
                {renderMarkdown ? "Show markdown source" : "Show rendered markdown"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={explorerOpen}
                  onPressedChange={toggleExplorer}
                  aria-label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
                  variant="default"
                  size="sm"
                >
                  <FolderTree className="size-3.5" />
                </Toggle>
              }
            />
            <TooltipPopup>
              {explorerOpen ? "Hide file explorer" : "Show file explorer"}
            </TooltipPopup>
          </Tooltip>
          {openInBrowser ? (
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Open in browser"
              onClick={openInBrowser}
            >
              <Eye className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
      {relativePath && file.data?.truncated && !showImage && !showPdf ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          Preview limited to the first 1 MB of a {(file.data.byteLength ?? 0).toLocaleString()} byte
          file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={previewBodyRef}
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden",
            relativePath ? "flex" : "hidden",
          )}
        >
          {relativePath && openInBrowser ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
              Open this file in the browser preview.
            </div>
          ) : relativePath && file.error && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
              {file.error}
            </div>
          ) : relativePath && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : relativePath && file.data ? (
            showImage ? (
              <WorkspaceImagePreview
                threadId={threadRef.threadId}
                relativePath={relativePath}
                httpBaseUrl={httpBaseUrl}
                createAssetUrl={environmentApi.assets.createUrl}
              />
            ) : showPdf ? (
              <WorkspacePdfPreview
                threadId={threadRef.threadId}
                relativePath={relativePath}
                httpBaseUrl={httpBaseUrl}
                createAssetUrl={environmentApi.assets.createUrl}
              />
            ) : file.data.binary ? (
              <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
                This binary file cannot be previewed or edited as text.
              </div>
            ) : showMarkdownToggle && renderMarkdown ? (
              <div className="min-h-0 flex-1 overflow-auto">
                <Suspense
                  fallback={
                    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
                      <LoaderCircle className="size-5 animate-spin" />
                    </div>
                  }
                >
                  <ChatMarkdown text={file.data.contents} cwd={cwd} threadRef={threadRef} />
                </Suspense>
              </div>
            ) : file.data.truncated ? (
              <Virtualizer
                key={`${relativePath}:${resolvedTheme}:${file.data.byteLength}`}
                className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                <File
                  file={{
                    name: relativePath,
                    contents: file.data.contents,
                    cacheKey: projectFileCacheKey(cwd, relativePath, file.data.contents),
                  }}
                  options={{
                    disableFileHeader: true,
                    overflow: "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme,
                  }}
                  className="min-h-full"
                />
              </Virtualizer>
            ) : (
              <EditableFileSurface
                key={`${relativePath}:${resolvedTheme}`}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                contents={file.data.contents}
                resolvedTheme={resolvedTheme}
                onPendingChange={onPendingChange}
              />
            )
          ) : null}
        </div>
        {explorerOpen || relativePath === null ? (
          <aside
            className={cn(
              "flex min-h-0 shrink-0 bg-background",
              relativePath
                ? "w-[min(22rem,46%)] min-w-64 border-l border-border/60"
                : "min-w-0 flex-1",
            )}
          >
            <FileBrowserPanel
              key={`${environmentId}:${cwd}`}
              environmentId={environmentId}
              cwd={cwd}
              projectName={projectName}
              selectedPath={relativePath}
              revealRequest={treeReveal}
              onOpenFile={onOpenFile}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
