"use client";

import { useLayoutEffect, useRef } from "react";

import {
  acquireBrowserSurface,
  useBrowserSurfaceStore,
  type BrowserSurfaceLease,
} from "./browserSurfaceStore";

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
  const presentationRef = useRef({ cornerRadius, zIndex });
  const updateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element || !visible) return;
    let lease: BrowserSurfaceLease | null = null;
    let updating = false;
    const update = () => {
      if (updating) return;
      updating = true;
      try {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          lease?.release();
          lease = null;
          return;
        }
        // A newly visible slot takes ownership. Displaced slots wait for a
        // release instead of synchronously fighting the current owner.
        if (!lease || useBrowserSurfaceStore.getState().byTabId[tabId]?.owner == null) {
          lease?.release();
          lease = acquireBrowserSurface(tabId, fitSourceContent);
        }
        const presentation = presentationRef.current;
        lease.present(
          {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
          },
          true,
          presentation.cornerRadius,
          presentation.zIndex,
        );
      } finally {
        updating = false;
      }
    };
    updateRef.current = update;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const unsubscribe = useBrowserSurfaceStore.subscribe((state, previous) => {
      if (state.byTabId[tabId]?.owner == null && previous.byTabId[tabId]?.owner != null) update();
    });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      unsubscribe();
      if (updateRef.current === update) updateRef.current = null;
      lease?.release();
    };
  }, [fitSourceContent, tabId, visible]);

  useLayoutEffect(() => {
    presentationRef.current = { cornerRadius, zIndex };
    updateRef.current?.();
  }, [cornerRadius, layoutVersion, visible, zIndex]);

  return <div ref={elementRef} className={className} data-browser-surface-slot={tabId} />;
}
