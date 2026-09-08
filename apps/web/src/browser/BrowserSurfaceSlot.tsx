"use client";

import { useLayoutEffect, useRef } from "react";

import { acquireBrowserSurface, useBrowserSurfaceStore } from "./browserSurfaceStore";

export function BrowserSurfaceSlot(props: {
  readonly tabId: string;
  readonly visible: boolean;
  readonly cornerRadius?: number | undefined;
  readonly zIndex?: number | undefined;
  /** Re-publishes a position-only layout change such as a floating-player drag. */
  readonly layoutVersion?: string | number | undefined;
  readonly className?: string;
  /** Preserves the full source viewport when placing it in a smaller surface. */
  readonly fitSourceContent?: boolean | undefined;
}) {
  const {
    tabId,
    visible,
    cornerRadius = 0,
    zIndex = 30,
    layoutVersion,
    className,
    fitSourceContent = false,
  } = props;
  const elementRef = useRef<HTMLDivElement | null>(null);
  const presentationRef = useRef({ visible, cornerRadius, zIndex });
  const updateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    presentationRef.current = { visible, cornerRadius, zIndex };
  }, [cornerRadius, visible, zIndex]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element || !visible) return;
    // Hidden retained slots must not displace the visible panel or mini-player.
    let lease = acquireBrowserSurface(tabId, fitSourceContent);
    const update = () => {
      const rect = element.getBoundingClientRect();
      const presentation = presentationRef.current;
      lease.present(
        {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
        },
        presentation.visible && rect.width > 0 && rect.height > 0,
        presentation.cornerRadius,
        presentation.zIndex,
      );
    };
    updateRef.current = update;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const unsubscribe = useBrowserSurfaceStore.subscribe(() => {
      // Read live state: an earlier listener may already have filled the vacancy.
      // Never displace an owner, including our own claim's synchronous notification.
      if (useBrowserSurfaceStore.getState().byTabId[tabId]?.owner != null) return;
      lease.release();
      lease = acquireBrowserSurface(tabId, fitSourceContent);
      update();
    });
    return () => {
      unsubscribe();
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      if (updateRef.current === update) updateRef.current = null;
      lease.release();
    };
  }, [fitSourceContent, tabId, visible]);

  useLayoutEffect(() => {
    updateRef.current?.();
  }, [cornerRadius, layoutVersion, visible, zIndex]);

  return <div ref={elementRef} className={className} data-browser-surface-slot={tabId} />;
}
