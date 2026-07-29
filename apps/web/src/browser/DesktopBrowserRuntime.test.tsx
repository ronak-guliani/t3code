import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DesktopBrowserRuntime } from "./DesktopBrowserRuntime";
import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { PreviewAutomationHosts } from "~/components/preview/PreviewAutomationHosts";

/**
 * `PreviewAutomationHosts` reaches the environment catalog on every platform so
 * a browser-served client can still register as unable to automate. This suite
 * renders on the server, so stand in a non-Electron `window` for it.
 */
function withBrowserWindow<A>(run: () => A): A {
  const globals = globalThis as { window?: unknown };
  const had = "window" in globals;
  const previous = globals.window;
  globals.window = { location: { origin: "https://t3.test" } };
  try {
    return run();
  } finally {
    if (had) globals.window = previous;
    else delete globals.window;
  }
}

describe("DesktopBrowserRuntime", () => {
  it("does not run any desktop host outside Electron", () => {
    expect(renderToStaticMarkup(<DesktopBrowserRuntime authenticated />)).toBe("");
    expect(renderToStaticMarkup(<ElectronBrowserHost />)).toBe("");
    expect(withBrowserWindow(() => renderToStaticMarkup(<PreviewAutomationHosts />))).toBe("");
  });

  it("does not mount desktop hosts before authentication", () => {
    expect(renderToStaticMarkup(<DesktopBrowserRuntime authenticated={false} />)).toBe("");
  });
});
