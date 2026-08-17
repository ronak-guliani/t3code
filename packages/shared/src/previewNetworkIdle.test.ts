import { describe, expect, it } from "vitest";

import { isNetworkIdleSample, resolveNetworkIdleQuietMs } from "./previewNetworkIdle.ts";

describe("previewNetworkIdle", () => {
  it("clamps quiet window", () => {
    expect(resolveNetworkIdleQuietMs()).toBe(500);
    expect(resolveNetworkIdleQuietMs(10)).toBe(50);
    expect(resolveNetworkIdleQuietMs(50_000)).toBe(5_000);
  });

  it("requires complete readyState and quiet resources", () => {
    expect(
      isNetworkIdleSample(
        {
          readyState: "interactive",
          loadingFlag: false,
          msSinceLastResource: 1_000,
          nowMs: 2_000,
        },
        500,
      ),
    ).toBe(false);

    expect(
      isNetworkIdleSample(
        {
          readyState: "complete",
          loadingFlag: true,
          msSinceLastResource: 1_000,
          nowMs: 2_000,
        },
        500,
      ),
    ).toBe(false);

    expect(
      isNetworkIdleSample(
        {
          readyState: "complete",
          loadingFlag: false,
          msSinceLastResource: 100,
          nowMs: 2_000,
        },
        500,
      ),
    ).toBe(false);

    expect(
      isNetworkIdleSample(
        {
          readyState: "complete",
          loadingFlag: false,
          msSinceLastResource: 600,
          nowMs: 2_000,
        },
        500,
      ),
    ).toBe(true);

    expect(
      isNetworkIdleSample(
        {
          readyState: "complete",
          loadingFlag: false,
          msSinceLastResource: null,
          nowMs: 2_000,
        },
        500,
      ),
    ).toBe(true);
  });
});
