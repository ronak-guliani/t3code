import { describe, expect, it } from "vitest";

import { resolveUniqueLocalThreadMatch } from "./diagnostics.ts";

describe("local thread target discovery", () => {
  it("selects a unique match only after all candidates were inspected", () => {
    expect(resolveUniqueLocalThreadMatch(["environment-a"], [])).toEqual({
      _tag: "Unique",
      match: "environment-a",
    });
    expect(
      resolveUniqueLocalThreadMatch(["environment-a"], [new Error("database unavailable")]),
    ).toEqual({
      _tag: "Incomplete",
    });
  });

  it("reports no match and ambiguity without choosing an environment", () => {
    expect(resolveUniqueLocalThreadMatch([], [])).toEqual({ _tag: "Missing" });
    expect(resolveUniqueLocalThreadMatch(["environment-a", "environment-b"], [])).toEqual({
      _tag: "Ambiguous",
    });
  });
});
