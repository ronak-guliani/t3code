import { describe, expect, it } from "vite-plus/test";

import { firstRouteParam } from "./routeParams";

describe("firstRouteParam", () => {
  it("returns undefined values as null", () => {
    expect(firstRouteParam(undefined)).toBeNull();
  });

  it("returns string values as-is", () => {
    expect(firstRouteParam("thread-1")).toBe("thread-1");
  });

  it("returns the first entry of array values", () => {
    expect(firstRouteParam(["a", "b"])).toBe("a");
  });

  it("returns null for empty arrays", () => {
    expect(firstRouteParam([])).toBeNull();
  });
});
