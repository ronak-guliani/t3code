import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ThreadStatusPill } from "./Sidebar.logic";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";

const workingStatus: ThreadStatusPill = {
  label: "Working",
  colorClass: "text-sky-600",
  dotClass: "bg-sky-500",
  pulse: true,
  presentation: "corner-badge",
};

const connectingStatus: ThreadStatusPill = {
  label: "Connecting",
  colorClass: "text-sky-600",
  dotClass: "bg-sky-500",
  pulse: true,
  presentation: "label",
};

const completedStatus: ThreadStatusPill = {
  label: "Completed",
  colorClass: "text-emerald-600",
  dotClass: "bg-emerald-500",
  pulse: false,
  presentation: "corner-badge",
};

describe("ThreadStatusLabel", () => {
  it("renders the slide spinner for the compact working status", () => {
    const html = renderToStaticMarkup(<ThreadStatusLabel compact status={workingStatus} />);

    expect(html).toContain("thread-slide");
    expect(html).toContain("text-white");
    expect(html).not.toContain("animate-status-pulse");
    expect(html).toContain("data-thread-status-pulse");
    expect(html).toContain("font-size:var(--app-sidebar-font-size)");
    expect(html.match(/thread-slide-dot/g)?.length).toBe(3);
  });

  it("keeps the slide spinner exempt from the native vibrancy animation freeze", () => {
    const html = renderToStaticMarkup(<ThreadStatusLabel compact status={workingStatus} />);

    expect(html.match(/data-thread-status-pulse/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("renders the slide spinner for the connecting label status", () => {
    const html = renderToStaticMarkup(<ThreadStatusLabel status={connectingStatus} />);

    expect(html).toContain("thread-slide");
    expect(html).not.toContain("animate-status-pulse");
    expect(html).toContain("Connecting");
  });

  it("keeps a static dot for non-pulsing statuses", () => {
    const html = renderToStaticMarkup(<ThreadStatusLabel compact status={completedStatus} />);

    expect(html).not.toContain("thread-slide");
    expect(html).not.toContain("data-thread-status-pulse");
    expect(html).toContain("size-[0.583em]");
  });
});
