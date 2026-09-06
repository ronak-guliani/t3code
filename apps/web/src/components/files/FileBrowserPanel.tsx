import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { ChevronsDownUp, ChevronsUpDown, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";

import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** File open in the preview pane; highlighted and revealed in the tree. */
  selectedPath: string | null;
  /** Bumped by breadcrumb clicks to reveal a directory without changing selection. */
  revealRequest: { path: string; nonce: number } | null;
  onOpenFile: (relativePath: string) => void;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

// Full resets collapse every expanded folder. Most refreshes only add or
// remove a few paths, so apply those as mutations and keep expansion.
const BATCH_UPDATE_FALLBACK_THRESHOLD = 200;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  revealRequest,
  onOpenFile,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  const entries = entriesQuery.data?.entries ?? [];
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const directoryPaths = useMemo(
    () => entries.filter((entry) => entry.kind === "directory").map(treePath),
    [entries],
  );
  const previousPathsRef = useRef<ReadonlySet<string> | null>(null);
  const syncingSelectionRef = useRef(false);
  const [allExpanded, setAllExpanded] = useState(false);

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // Programmatic reveals below echo back through here; ignore them.
      if (syncingSelectionRef.current) return;
      const next = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (next && entryKindsRef.current.get(next) === "file") {
        onOpenFile(next);
      }
    },
    paths: [],
    search: true,
    unsafeCSS: TREE_UNSAFE_CSS,
  });

  useEffect(() => {
    entryKindsRef.current = entryKinds;
    const next = new Set(treePaths);
    const previous = previousPathsRef.current;
    previousPathsRef.current = next;
    if (previous === null) {
      model.resetPaths(treePaths);
      return;
    }
    const removed = [...previous]
      .filter((path) => !next.has(path))
      .sort((a, b) => b.length - a.length);
    const added = [...next]
      .filter((path) => !previous.has(path))
      .sort((a, b) => a.length - b.length);
    if (removed.length === 0 && added.length === 0) return;
    if (removed.length + added.length > BATCH_UPDATE_FALLBACK_THRESHOLD) {
      model.resetPaths(treePaths);
      return;
    }
    try {
      model.batch([
        ...removed.map((path) => ({ type: "remove" as const, path })),
        ...added.map((path) => ({ type: "add" as const, path })),
      ]);
    } catch {
      model.resetPaths(treePaths);
    }
  }, [entryKinds, model, treePaths]);

  const reveal = useCallback(
    (path: string, select: boolean) => {
      const normalized = path.replace(/\/$/, "");
      if (select && entryKindsRef.current.get(normalized) !== "file") return;
      if (
        model.getSelectedPaths().some((candidate) => candidate.replace(/\/$/, "") === normalized)
      ) {
        model.scrollToPath(select ? normalized : path, { offset: "center" });
        return;
      }
      const segments = normalized.split("/").filter(Boolean);
      let ancestor = "";
      for (const segment of segments.slice(0, -1)) {
        ancestor = ancestor ? `${ancestor}/${segment}` : segment;
        const item = model.getItem(`${ancestor}/`) ?? model.getItem(ancestor);
        if (item && "expand" in item) item.expand();
      }
      if (!select) {
        model.scrollToPath(path, { offset: "center" });
        return;
      }
      const item = model.getItem(normalized);
      if (!item) return;
      syncingSelectionRef.current = true;
      for (const selected of model.getSelectedPaths()) {
        if (selected.replace(/\/$/, "") !== normalized) model.getItem(selected)?.deselect();
      }
      item.select();
      model.scrollToPath(normalized, { offset: "center" });
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
    },
    [model],
  );

  // Follow the open file. The already-selected check inside `reveal` keeps
  // entry refreshes from stealing focus or closing an active tree search.
  useEffect(() => {
    if (!selectedPath) return;
    reveal(selectedPath, true);
  }, [model, reveal, selectedPath, treePaths]);

  // Breadcrumb clicks reveal a directory without touching file selection.
  useEffect(() => {
    if (!revealRequest) return;
    reveal(revealRequest.path, false);
  }, [model, reveal, revealRequest, treePaths]);

  const toggleAllDirectories = () => {
    const next = !allExpanded;
    setAllExpanded(next);
    for (const dir of directoryPaths) {
      const item = model.getItem(dir);
      if (item && "expand" in item) {
        if (next) item.expand();
        else item.collapse();
      }
    }
  };

  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{projectName}</div>
          <div className="truncate text-[10px] leading-none text-muted-foreground">
            {entriesQuery.isPending && entriesQuery.data === null
              ? "Indexing…"
              : `${fileCount.toLocaleString()} files`}
            {entriesQuery.data?.truncated ? " · partial" : ""}
          </div>
        </div>
        {directoryPaths.length > 0 ? (
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={allExpanded ? "Collapse all folders" : "Expand all folders"}
            title={allExpanded ? "Collapse all folders" : "Expand all folders"}
            onClick={toggleAllDirectories}
          >
            {allExpanded ? (
              <ChevronsDownUp className="size-3.5" />
            ) : (
              <ChevronsUpDown className="size-3.5" />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Search workspace files"
          onClick={() => model.openSearch()}
        >
          <Search className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh workspace files"
          onClick={entriesQuery.refresh}
        >
          <RefreshCw className={cn("size-3.5", entriesQuery.isPending && "animate-spin")} />
        </button>
      </div>
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{entriesQuery.error}</div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={{
            colorScheme: resolvedTheme,
            ["--trees-fg-override" as string]: "var(--foreground)",
          }}
        />
      )}
    </div>
  );
}
