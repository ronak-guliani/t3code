import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RetainedRightPanelSurface } from "./RetainedRightPanelSurface";

describe("RetainedRightPanelSurface", () => {
  it("exposes the surface kind while visible", () => {
    const markup = renderToStaticMarkup(
      <RetainedRightPanelSurface visible surface="preview">
        <span>preview content</span>
      </RetainedRightPanelSurface>,
    );
    expect(markup).toContain("preview content");
    expect(markup).toContain('data-chat-view-right-panel-surface="preview"');
    expect(markup).toContain('class="h-full min-h-0"');
    expect(markup).toContain('aria-hidden="false"');
  });

  it("keeps inactive surfaces mounted but hidden from assistive tech", () => {
    const markup = renderToStaticMarkup(
      <RetainedRightPanelSurface visible={false} surface="terminal">
        <span>terminal content</span>
      </RetainedRightPanelSurface>,
    );
    expect(markup).toContain("terminal content");
    expect(markup).toContain('class="h-full min-h-0 hidden"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("data-chat-view-right-panel-surface=");
  });
});
