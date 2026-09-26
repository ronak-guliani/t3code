import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export type RetainedRightPanelSurfaceKind =
  | "plan"
  | "preview"
  | "diff"
  | "insights"
  | "terminal"
  | "files"
  | "file";

interface RetainedRightPanelSurfaceProps {
  readonly visible: boolean;
  readonly surface: RetainedRightPanelSurfaceKind;
  readonly children: ReactNode;
}

/**
 * Single owner of right-panel retention semantics: surfaces stay mounted so
 * thread switches do not lose panel state; the inactive surface hides with CSS
 * instead of unmounting. Previously six near-identical wrappers in ChatView
 * each re-implemented this div; fix retention, visibility, or a11y here once.
 */
export const RetainedRightPanelSurface = memo(function RetainedRightPanelSurface({
  visible,
  surface,
  children,
}: RetainedRightPanelSurfaceProps) {
  return (
    <div
      className={cn("h-full min-h-0", !visible && "hidden")}
      data-chat-view-right-panel-surface={visible ? surface : undefined}
      aria-hidden={!visible}
    >
      {children}
    </div>
  );
});
