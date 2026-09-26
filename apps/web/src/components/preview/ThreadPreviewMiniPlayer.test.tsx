import { EnvironmentId, ThreadId, type PreviewViewportSetting } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

const mocks = vi.hoisted(() => ({
  miniPlayer: {
    source: { kind: "browser" as const, tabId: "older-tab" },
    position: null,
    width: null,
  },
  viewport: { _tag: "fill" } as PreviewViewportSetting | undefined,
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

vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
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

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  mocks.viewport = { _tag: "fill" };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const view = () => (
  <ThreadPreviewMiniPlayer threadRef={threadRef} miniPlayer={mocks.miniPlayer} bottomInset={0} />
);

async function renderMiniPlayer() {
  await act(async () => {
    renderer = create(view(), {
      createNodeMock: () => ({ clientWidth: 1000, clientHeight: 800 }),
    });
  });
  return renderer!;
}

describe("ThreadPreviewMiniPlayer", () => {
  it("presents the stored tab rather than the active tab", async () => {
    const player = await renderMiniPlayer();

    expect(player.root.findAllByType(BrowserSurfaceSlot)).toHaveLength(1);
    expect(player.root.findByType(BrowserSurfaceSlot).props).toMatchObject({
      tabId: previewRuntimeTabId(threadRef, "epoch-1", "older-tab"),
      visible: true,
    });
  });

  it.each([
    { name: "fill", viewport: { _tag: "fill" } as const, fitSourceContent: false },
    { name: "missing", viewport: undefined, fitSourceContent: false },
    {
      name: "freeform",
      viewport: { _tag: "freeform", width: 393, height: 852 } as const,
      fitSourceContent: true,
    },
    {
      name: "device preset",
      viewport: {
        _tag: "preset",
        presetId: "iphone-12-pro",
        width: 390,
        height: 844,
      } as const,
      fitSourceContent: true,
    },
  ])("uses fitSourceContent=$fitSourceContent for $name viewports", async (testCase) => {
    mocks.viewport = testCase.viewport;
    const player = await renderMiniPlayer();

    expect(player.root.findByType(BrowserSurfaceSlot).props.fitSourceContent).toBe(
      testCase.fitSourceContent,
    );
  });

  it("stops fitting source content when switching a fixed viewport to fill", async () => {
    mocks.viewport = { _tag: "freeform", width: 393, height: 852 };
    const player = await renderMiniPlayer();
    expect(player.root.findByType(BrowserSurfaceSlot).props.fitSourceContent).toBe(true);

    mocks.viewport = { _tag: "fill" };
    await act(async () => player.update(view()));

    expect(player.root.findByType(BrowserSurfaceSlot).props.fitSourceContent).toBe(false);
  });
});
