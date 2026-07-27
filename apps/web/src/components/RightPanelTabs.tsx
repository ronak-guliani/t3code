import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { ClipboardList, FileDiff, Files, Globe2, Plus, TerminalSquare, X } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";

type Props = {
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurfaceId: string | null;
  readonly previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  readonly onActivate: (surface: RightPanelSurface) => void;
  readonly onClose: (surface: RightPanelSurface) => void;
  readonly onAdd: () => void;
  readonly children: ReactNode;
};

function titleFor(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): string {
  switch (surface.kind) {
    case "plan":
      return "Plan";
    case "diff":
      return "Diff";
    case "files":
      return "Files";
    case "file":
      return surface.relativePath.split("/").at(-1) ?? surface.relativePath;
    case "terminal":
      return "Terminal";
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return "Browser";
      return snapshot.navStatus.title || new URL(snapshot.navStatus.url).host || "Browser";
    }
  }
}

function Icon({ surface }: { readonly surface: RightPanelSurface }) {
  switch (surface.kind) {
    case "plan":
      return <ClipboardList className="size-3.5" />;
    case "diff":
      return <FileDiff className="size-3.5" />;
    case "files":
    case "file":
      return <Files className="size-3.5" />;
    case "terminal":
      return <TerminalSquare className="size-3.5" />;
    case "preview":
      return <Globe2 className="size-3.5" />;
  }
}

export function RightPanelTabs({
  surfaces,
  activeSurfaceId,
  previewSessions,
  onActivate,
  onClose,
  onAdd,
  children,
}: Props) {
  const closeOnMiddleClick = (event: MouseEvent, surface: RightPanelSurface) => {
    if (event.button !== 1) return;
    event.preventDefault();
    onClose(surface);
  };

  return (
    <section className="flex min-h-0 w-[min(42vw,36rem)] min-w-80 flex-col border-l border-border bg-card max-[980px]:w-full max-[980px]:min-w-0">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {surfaces.map((surface) => {
            const title = titleFor(surface, previewSessions);
            const active = surface.id === activeSurfaceId;
            return (
              <button
                key={surface.id}
                type="button"
                title={title}
                onClick={() => onActivate(surface)}
                onAuxClick={(event) => closeOnMiddleClick(event, surface)}
                className={cn(
                  "group flex h-7 min-w-24 max-w-44 shrink-0 items-center gap-1.5 rounded px-2 text-xs",
                  active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                <Icon surface={surface} />
                <span className="min-w-0 flex-1 truncate text-left">{title}</span>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(surface);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      onClose(surface);
                    }
                  }}
                  className="opacity-0 group-hover:opacity-100"
                >
                  <X className="size-3" />
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          aria-label="Add browser surface"
          onClick={onAdd}
          className="rounded p-1 hover:bg-accent"
        >
          <Plus className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
