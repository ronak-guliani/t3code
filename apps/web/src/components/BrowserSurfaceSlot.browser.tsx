import "../index.css";

import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";

afterEach(() => {
  useBrowserSurfaceStore.setState({ byTabId: {} });
});

it("waits for layout before claiming and releases a slot when its parent is hidden", async () => {
  const screen = await render(
    <div hidden style={{ width: 400, height: 300 }}>
      <BrowserSurfaceSlot tabId="measured-tab" visible className="size-full" />
    </div>,
  );
  try {
    expect(useBrowserSurfaceStore.getState().byTabId["measured-tab"]?.owner).toBeUndefined();
    await screen.rerender(
      <div style={{ width: 400, height: 300 }}>
        <BrowserSurfaceSlot tabId="measured-tab" visible className="size-full" />
      </div>,
    );
    await expect
      .poll(() => useBrowserSurfaceStore.getState().byTabId["measured-tab"]?.visible)
      .toBe(true);
    await screen.rerender(
      <div hidden style={{ width: 400, height: 300 }}>
        <BrowserSurfaceSlot tabId="measured-tab" visible className="size-full" />
      </div>,
    );
    await expect
      .poll(() => useBrowserSurfaceStore.getState().byTabId["measured-tab"]?.owner)
      .toBeNull();
    expect(useBrowserSurfaceStore.getState().byTabId["measured-tab"]?.visible).toBe(false);
  } finally {
    await screen.unmount();
  }
});

it.each([false, true])(
  "hands the browser between a retained panel and floating preview (panel first: %s)",
  async (panelFirst) => {
    const surfaces = (panelVisible: boolean) => {
      const panel = (
        <div key="panel" style={{ width: 600, height: 400 }} hidden={!panelVisible}>
          <BrowserSurfaceSlot tabId="handoff-tab" visible={panelVisible} className="size-full" />
        </div>
      );
      const floating = panelVisible ? null : (
        <div key="floating" style={{ width: 320, height: 200 }}>
          <BrowserSurfaceSlot tabId="handoff-tab" visible fitSourceContent className="size-full" />
        </div>
      );
      return <>{panelFirst ? [panel, floating] : [floating, panel]}</>;
    };
    const screen = await render(surfaces(true));
    try {
      for (let index = 0; index < 10; index += 1) {
        await screen.rerender(surfaces(false));
        expect(useBrowserSurfaceStore.getState().byTabId["handoff-tab"]).toMatchObject({
          visible: true,
          fitSourceContent: true,
          rect: { width: 320, height: 200 },
        });
        await screen.rerender(surfaces(true));
        expect(useBrowserSurfaceStore.getState().byTabId["handoff-tab"]).toMatchObject({
          visible: true,
          fitSourceContent: false,
          rect: { width: 600, height: 400 },
        });
      }
    } finally {
      await screen.unmount();
    }
  },
);

it("returns ownership to a still-visible slot when the newer slot unmounts", async () => {
  const surfaces = (second: boolean) => (
    <>
      <div style={{ width: 600, height: 400 }}>
        <BrowserSurfaceSlot tabId="overlap-tab" visible className="size-full" />
      </div>
      {second ? (
        <div style={{ width: 320, height: 200 }}>
          <BrowserSurfaceSlot tabId="overlap-tab" visible className="size-full" />
        </div>
      ) : null}
    </>
  );
  const screen = await render(surfaces(false));
  try {
    await screen.rerender(surfaces(true));
    expect(useBrowserSurfaceStore.getState().byTabId["overlap-tab"]).toMatchObject({
      visible: true,
      rect: { width: 320, height: 200 },
    });
    window.dispatchEvent(new Event("resize"));
    expect(useBrowserSurfaceStore.getState().byTabId["overlap-tab"]?.rect?.width).toBe(320);
    await screen.rerender(surfaces(false));
    expect(useBrowserSurfaceStore.getState().byTabId["overlap-tab"]).toMatchObject({
      visible: true,
      rect: { width: 600, height: 400 },
    });
  } finally {
    await screen.unmount();
  }
});

it("keeps the visible browser presented when a hidden retained panel mounts", async () => {
  const screen = await render(
    <div style={{ width: 400, height: 300 }}>
      <BrowserSurfaceSlot tabId="shared-tab" visible className="size-full" />
    </div>,
  );
  try {
    expect(useBrowserSurfaceStore.getState().byTabId["shared-tab"]?.visible).toBe(true);
    await screen.rerender(
      <div style={{ width: 400, height: 300 }}>
        <BrowserSurfaceSlot tabId="shared-tab" visible className="size-full" />
        <div hidden>
          <BrowserSurfaceSlot tabId="shared-tab" visible={false} />
        </div>
      </div>,
    );
    expect(useBrowserSurfaceStore.getState().byTabId["shared-tab"]?.visible).toBe(true);
  } finally {
    await screen.unmount();
  }
});

function Slots({ panelVisible }: { panelVisible: boolean }) {
  return (
    <div style={{ display: "grid", width: 300, height: 300 }}>
      <BrowserSurfaceSlot tabId="shared" visible={!panelVisible} cornerRadius={12} />
      <BrowserSurfaceSlot tabId="shared" visible={panelVisible} cornerRadius={0} />
    </div>
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
  const screen = await render(
    <BrowserSurfaceSlot tabId="shared" visible cornerRadius={12} className="size-32" />,
  );
  await screen.rerender(
    <>
      <BrowserSurfaceSlot tabId="shared" visible cornerRadius={12} className="size-32" />
      <BrowserSurfaceSlot tabId="shared" visible cornerRadius={0} className="size-32" />
    </>,
  );
  const owner = useBrowserSurfaceStore.getState().byTabId.shared?.owner;
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("scroll"));
  expect(useBrowserSurfaceStore.getState().byTabId.shared?.owner).toBe(owner);
  expect(useBrowserSurfaceStore.getState().byTabId.shared?.cornerRadius).toBe(0);

  await screen.rerender(
    <BrowserSurfaceSlot tabId="shared" visible cornerRadius={12} className="size-32" />,
  );
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
