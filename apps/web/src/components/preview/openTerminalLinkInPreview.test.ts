import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { openTerminalLinkInPreview } from "./openTerminalLinkInPreview";

const { openSession, openBrowser } = vi.hoisted(() => ({
  openSession: vi.fn(),
  openBrowser: vi.fn(),
}));
vi.mock("./openPreviewSession", () => ({ openPreviewSession: openSession }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => true }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser }) },
}));
vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: async () => undefined,
  getClientSettings: () => ({ browserLinkTarget: "app" }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  openSession.mockResolvedValue(AsyncResult.success({ tabId: "tab-1" }));
});

it("uses the shared default-aware opening path on an ordinary URL click", async () => {
  const threadRef = {
    environmentId: EnvironmentId.make("local"),
    threadId: ThreadId.make("thread"),
  };
  const openPreview = vi.fn();
  const fallbackToBrowser = vi.fn();
  await openTerminalLinkInPreview({
    threadRef,
    url: "https://example.com",
    openPreview,
    fallbackToBrowser,
    event: { metaKey: false, ctrlKey: false },
  });
  expect(openSession).toHaveBeenCalledWith({ threadRef, url: "https://example.com", openPreview });
  expect(openBrowser).toHaveBeenCalledWith(threadRef, "tab-1");
  expect(fallbackToBrowser).not.toHaveBeenCalled();
});

it.each(["metaKey", "ctrlKey"] as const)("preserves %s as the external override", async (key) => {
  const fallbackToBrowser = vi.fn();
  await openTerminalLinkInPreview({
    threadRef: { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("thread") },
    url: "https://example.com",
    openPreview: vi.fn(),
    fallbackToBrowser,
    event: { metaKey: false, ctrlKey: false, [key]: true },
  });
  expect(fallbackToBrowser).toHaveBeenCalledOnce();
  expect(openSession).not.toHaveBeenCalled();
});
