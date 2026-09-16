import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  miniPlayer: {
    source: { kind: "browser" as const, tabId: "older-tab" },
    position: null,
    width: null,
  },
  viewport: { _tag: "fill" } as
    | { readonly _tag: "fill" }
    | { readonly _tag: "freeform"; readonly width: number; readonly height: number },
}));

vi.mock("~/browser/BrowserSurfaceSlot", () => ({
  BrowserSurfaceSlot: ({
    fitSourceContent,
    tabId,
  }: {
    fitSourceContent?: boolean;
    tabId: string;
  }) => (
    <div
      data-browser-surface-tab-id={tabId}
      data-fit-source-content={String(fitSourceContent ?? false)}
    />
  ),
}));

vi.mock("~/previewStateStore", () => ({
  useThreadPreviewState: () => ({
    activeTabId: "active-tab",
    serverEpoch: "epoch-1",
    desktopByTabId: {
      "active-tab": {},
      "older-tab": {},
    },
    sessions: {
      "active-tab": {},
      "older-tab": { viewport: mocks.viewport },
    },
  }),
}));

vi.mock("./previewBridge", () => ({ previewBridge: null }));

vi.mock("~/previewMiniPlayerStore", () => ({
  previewMiniPlayerSourceKey: (source: { kind: "browser"; tabId: string }) =>
    `browser:${source.tabId}`,
  selectThreadPreviewMiniPlayer: () => mocks.miniPlayer,
  usePreviewMiniPlayerStore: Object.assign(() => mocks.miniPlayer, {
    getState: () => ({ close: vi.fn(), move: vi.fn(), resize: vi.fn() }),
  }),
}));

import { ThreadPreviewMiniPlayer } from "./ThreadPreviewMiniPlayer";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("ThreadPreviewMiniPlayer", () => {
  it("renders the floating preview shell for the stored tab", () => {
    const markup = renderToStaticMarkup(
      <ThreadPreviewMiniPlayer
        threadRef={threadRef}
        miniPlayer={mocks.miniPlayer}
        bottomInset={0}
      />,
    );

    expect(markup).toContain("pointer-events-none absolute inset-0");
  });

  it("supports fill-mode content in the floating preview", () => {
    mocks.viewport = { _tag: "fill" };

    const markup = renderToStaticMarkup(
      <ThreadPreviewMiniPlayer
        threadRef={threadRef}
        miniPlayer={mocks.miniPlayer}
        bottomInset={0}
      />,
    );

    expect(markup).toContain("pointer-events-none absolute inset-0");
  });

  it("supports explicitly selected fixed viewport dimensions", () => {
    mocks.viewport = { _tag: "freeform", width: 393, height: 852 };

    const markup = renderToStaticMarkup(
      <ThreadPreviewMiniPlayer
        threadRef={threadRef}
        miniPlayer={mocks.miniPlayer}
        bottomInset={0}
      />,
    );

    expect(markup).toContain("pointer-events-none absolute inset-0");
  });
});
