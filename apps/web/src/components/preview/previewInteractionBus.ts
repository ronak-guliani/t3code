"use client";

const EVENT_NAME = "t3code:preview-interaction";

export function dispatchPreviewInteraction(tabId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(EVENT_NAME, { detail: tabId }));
}

export function subscribePreviewInteraction(listener: (tabId: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const tabId = (event as CustomEvent<unknown>).detail;
    if (typeof tabId === "string") listener(tabId);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
