import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("./previewBridge", () => ({
  previewBridge: {
    clearCache: vi.fn(async () => undefined),
    clearCookies: vi.fn(async () => undefined),
    hardReload: vi.fn(async () => undefined),
    openDevTools: vi.fn(async () => undefined),
    resetZoom: vi.fn(async () => undefined),
    setColorScheme: vi.fn(async () => undefined),
    zoomIn: vi.fn(async () => undefined),
    zoomOut: vi.fn(async () => undefined),
  },
}));

import { PreviewMoreMenu } from "./PreviewMoreMenu";
import { dispatchPreviewInteraction } from "./previewInteractionBus";

describe("PreviewMoreMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("closes when the active guest webview receives human input", async () => {
    const screen = await render(
      <PreviewMoreMenu
        tabId="tab-1"
        hasWebContents
        zoomFactor={1}
        colorScheme="system"
        deviceToolbarVisible={false}
        onToggleDeviceToolbar={vi.fn()}
        onToggleNativePictureInPicture={vi.fn()}
        nativePictureInPicture={false}
        nativePictureInPictureDisabled={false}
      />,
    );
    try {
      await page.getByLabelText("Preview menu").click();
      await expect.element(page.getByText("Hard reload")).toBeVisible();

      dispatchPreviewInteraction("tab-2");
      await expect.element(page.getByText("Hard reload")).toBeVisible();

      dispatchPreviewInteraction("tab-1");
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("Hard reload");
      });
    } finally {
      await screen.unmount();
    }
  });
});
