import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarProvider, SidebarTrigger } from "./sidebar";

describe("sidebar collapse trigger", () => {
  it("exposes expanded state and a collapse label when open", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain('data-slot="sidebar-trigger"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Collapse sidebar");
  });

  it("exposes collapsed state and an expand label when closed", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen={false}>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain('data-slot="sidebar-trigger"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Expand sidebar");
  });
});
