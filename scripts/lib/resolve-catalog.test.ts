import { describe, expect, it } from "vitest";

import { resolvePackagedCliDependencies } from "./resolve-catalog.ts";

describe("resolvePackagedCliDependencies", () => {
  it("resolves catalog versions and omits bundled workspace packages", () => {
    expect(
      resolvePackagedCliDependencies(
        {
          effect: "catalog:",
          "@t3tools/client-runtime": "workspace:*",
          "node-pty": "^1.1.0",
        },
        { effect: "4.0.0" },
        "apps/server",
      ),
    ).toEqual({
      effect: "4.0.0",
      "node-pty": "^1.1.0",
    });
  });

  it("retains non-workspace runtime dependencies even under the bundled namespace", () => {
    expect(
      resolvePackagedCliDependencies({ "@t3tools/external-runtime": "^1.2.3" }, {}, "apps/server"),
    ).toEqual({ "@t3tools/external-runtime": "^1.2.3" });
  });
});
