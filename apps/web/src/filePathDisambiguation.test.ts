import { describe, expect, it } from "vitest";

import { buildFileParentSuffixByPath } from "./filePathDisambiguation";

describe("buildFileParentSuffixByPath", () => {
  it("returns no suffix for unique basenames", () => {
    expect(buildFileParentSuffixByPath(["src/index.ts", "src/main.ts"]).size).toBe(0);
  });

  it("disambiguates duplicate basenames with parent suffixes", () => {
    const suffixByPath = buildFileParentSuffixByPath([
      "/Users/julius/project/src/components/chat/MessagesTimeline.tsx",
      "/Users/julius/project/src/components/MessagesTimeline.tsx",
    ]);

    expect(suffixByPath.get("/Users/julius/project/src/components/chat/MessagesTimeline.tsx")).toBe(
      "components/chat",
    );
    expect(suffixByPath.get("/Users/julius/project/src/components/MessagesTimeline.tsx")).toBe(
      "src/components",
    );
  });

  it("uses the full parent chain when it is short", () => {
    const suffixByPath = buildFileParentSuffixByPath(["a/foo.ts", "b/foo.ts"]);

    expect(suffixByPath.get("a/foo.ts")).toBe("a");
    expect(suffixByPath.get("b/foo.ts")).toBe("b");
  });

  it("extends the suffix until it is unique", () => {
    const suffixByPath = buildFileParentSuffixByPath([
      "src/a/settings.ts",
      "src/b/settings.ts",
      "other/settings.ts",
    ]);

    expect(suffixByPath.get("src/a/settings.ts")).toBe("src/a");
    expect(suffixByPath.get("src/b/settings.ts")).toBe("src/b");
    expect(suffixByPath.get("other/settings.ts")).toBe("other");
  });

  it("ignores basenames without parents", () => {
    expect(buildFileParentSuffixByPath(["settings.ts", "settings.ts"]).size).toBe(0);
  });
});
