import { describe, expect, it } from "vitest";

import { readWindowZoomFactor, TITLEBAR_TRAFFIC_LIGHT_INSET_CLASS } from "./titlebar";

describe("readWindowZoomFactor", () => {
  it("derives the zoom factor from the screen-point to CSS-pixel ratio", () => {
    expect(readWindowZoomFactor({ outerWidth: 1600, innerWidth: 1600 })).toBe(1);
    expect(readWindowZoomFactor({ outerWidth: 1600, innerWidth: 1067 })).toBeCloseTo(1.5, 2);
    expect(readWindowZoomFactor({ outerWidth: 1200, innerWidth: 1600 })).toBeCloseTo(0.75, 2);
  });

  it.each([
    ["a minimised window", { outerWidth: 1600, innerWidth: 0 }],
    ["an out-of-range ratio", { outerWidth: 1600, innerWidth: 100 }],
    ["a non-finite measurement", { outerWidth: Number.NaN, innerWidth: 1600 }],
  ])("falls back to 1 for %s", (_label, view) => {
    expect(readWindowZoomFactor(view)).toBe(1);
  });
});

describe("TITLEBAR_TRAFFIC_LIGHT_INSET_CLASS", () => {
  it("resolves to the unzoomed 80px inset when the zoom variable is unset", () => {
    // 28px gap + the 52pt traffic-light span, which only shrinks in CSS pixels
    // once the page is zoomed.
    expect(TITLEBAR_TRAFFIC_LIGHT_INSET_CLASS).toContain("calc(28px+52px/var(--app-zoom,1))");
  });
});
