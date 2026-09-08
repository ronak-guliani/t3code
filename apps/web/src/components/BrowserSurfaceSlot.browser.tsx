import { beforeEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";

beforeEach(() => {
  useBrowserSurfaceStore.setState({ byTabId: {} });
});

function Slots({ panelVisible }: { panelVisible: boolean }) {
  return (
    <>
      <BrowserSurfaceSlot tabId="shared" visible={!panelVisible} cornerRadius={12} />
      <BrowserSurfaceSlot tabId="shared" visible={panelVisible} cornerRadius={0} />
    </>
  );
}

it("hands ownership between retained panel and mini-player slots", async () => {
  const screen = await render(<Slots panelVisible={false} />);
  expect(useBrowserSurfaceStore.getState().byTabId.shared?.cornerRadius).toBe(12);

  await screen.rerender(<Slots panelVisible />);
  expect(useBrowserSurfaceStore.getState().byTabId.shared?.cornerRadius).toBe(0);

  await screen.rerender(<Slots panelVisible={false} />);
  expect(useBrowserSurfaceStore.getState().byTabId.shared?.cornerRadius).toBe(12);
  expect(useBrowserSurfaceStore.getState().byTabId.shared?.owner).not.toBeNull();
});

it("does not reclaim ownership from another visible slot during layout updates", async () => {
  const screen = await render(<BrowserSurfaceSlot tabId="shared" visible cornerRadius={12} />);
  await screen.rerender(
    <>
      <BrowserSurfaceSlot tabId="shared" visible cornerRadius={12} />
      <BrowserSurfaceSlot tabId="shared" visible cornerRadius={0} />
    </>,
  );
  const owner = useBrowserSurfaceStore.getState().byTabId.shared?.owner;
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("scroll"));
  expect(useBrowserSurfaceStore.getState().byTabId.shared?.owner).toBe(owner);
  expect(useBrowserSurfaceStore.getState().byTabId.shared?.cornerRadius).toBe(0);

  await screen.rerender(<BrowserSurfaceSlot tabId="shared" visible cornerRadius={12} />);
  expect(useBrowserSurfaceStore.getState().byTabId.shared?.owner).not.toBeNull();
  expect(useBrowserSurfaceStore.getState().byTabId.shared?.cornerRadius).toBe(12);
});

it("promotes one visible contender when the owner hides and releases on unmount", async () => {
  function Contenders({ ownerVisible }: { ownerVisible: boolean }) {
    return (
      <div style={{ display: "grid", width: 300, height: 300 }}>
        <BrowserSurfaceSlot tabId="shared" visible cornerRadius={12} />
        <BrowserSurfaceSlot tabId="shared" visible cornerRadius={8} />
        <BrowserSurfaceSlot tabId="shared" visible={ownerVisible} cornerRadius={0} />
      </div>
    );
  }

  const screen = await render(<Contenders ownerVisible />);
  expect(useBrowserSurfaceStore.getState().byTabId.shared).toMatchObject({
    visible: true,
    cornerRadius: 0,
  });

  await screen.rerender(<Contenders ownerVisible={false} />);
  const presentation = useBrowserSurfaceStore.getState().byTabId.shared;
  expect(presentation?.owner).not.toBeNull();
  expect(presentation).toMatchObject({ visible: true, cornerRadius: 12 });
  window.dispatchEvent(new Event("resize"));
  expect(useBrowserSurfaceStore.getState().byTabId.shared?.owner).toBe(presentation?.owner);

  await screen.unmount();
  expect(useBrowserSurfaceStore.getState().byTabId.shared).toMatchObject({
    visible: false,
    owner: null,
  });
});
