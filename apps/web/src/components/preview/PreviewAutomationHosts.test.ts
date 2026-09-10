import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

const { desktopStatus } = vi.hoisted(() => ({
  desktopStatus: vi.fn(),
}));

vi.mock("./previewBridge", () => ({
  previewBridge: { automation: { status: desktopStatus } },
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import {
  applyPreviewDesktopState,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { readPreviewAutomationStatus } from "./PreviewAutomationHosts";
import { resolvePreviewAutomationTarget } from "./previewAutomationTarget";

afterEach(resetPreviewStateForTests);

it("returns a server tab ID that can target the next command after reading desktop status", async () => {
  const threadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  };
  const runtimeTabId = previewRuntimeTabId(threadRef, "server-epoch", "tab_1");
  reconcilePreviewServerSessions(threadRef, {
    serverEpoch: "server-epoch",
    revision: 1,
    sessions: [
      {
        tabId: "tab_1",
        threadId: threadRef.threadId,
        navStatus: { _tag: "Success", url: "http://localhost:5733", title: "Test app" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: new Date(0).toISOString(),
      },
    ],
  });
  applyPreviewDesktopState(threadRef, "tab_1", {
    canGoBack: false,
    canGoForward: false,
    loading: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system",
    controller: "none",
  });
  desktopStatus.mockResolvedValue({
    available: true,
    tabId: runtimeTabId,
    url: "http://localhost:5733",
    title: "Test app",
    loading: false,
  });
  const result = await readPreviewAutomationStatus(threadRef, "tab_1");
  expect(desktopStatus).toHaveBeenCalledWith(runtimeTabId);
  expect(result.tabId).toBe("tab_1");
  expect(
    resolvePreviewAutomationTarget(readThreadPreviewState(threadRef), result.tabId).tabId,
  ).toBe("tab_1");
});
