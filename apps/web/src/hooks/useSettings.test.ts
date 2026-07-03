import { describe, expect, it } from "vitest";
import { reuseShallowEqualSettingsSelection } from "./settingsSelectorStability";

describe("reuseShallowEqualSettingsSelection", () => {
  it("reuses object selector results when their fields are shallow-equal", () => {
    const first = {
      sidebarProjectGroupingMode: "auto",
      sidebarProjectGroupingOverrides: { project: "repository" },
    };
    const second = {
      sidebarProjectGroupingMode: "auto",
      sidebarProjectGroupingOverrides: first.sidebarProjectGroupingOverrides,
    };

    expect(reuseShallowEqualSettingsSelection({ value: first }, second)).toBe(first);
  });

  it("returns the next selector result when a selected field changes", () => {
    const first = {
      sidebarProjectGroupingMode: "auto",
      sidebarProjectGroupingOverrides: { project: "repository" },
    };
    const second = {
      sidebarProjectGroupingMode: "physical",
      sidebarProjectGroupingOverrides: first.sidebarProjectGroupingOverrides,
    };

    expect(reuseShallowEqualSettingsSelection({ value: first }, second)).toBe(second);
  });
});
