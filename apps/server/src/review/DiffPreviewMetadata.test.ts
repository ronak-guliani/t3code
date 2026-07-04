import { describe, expect, it } from "vite-plus/test";

import { analyzeReviewDiff } from "./DiffPreviewMetadata.ts";

describe("analyzeReviewDiff", () => {
  it("summarizes per-file additions and deletions", () => {
    const result = analyzeReviewDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1,2 @@",
        "-old",
        "+new",
        "+line",
      ].join("\n"),
    );

    expect(result.metadata).toEqual({
      filesChanged: 1,
      totalAdditions: 2,
      totalDeletions: 1,
      largeFiles: 0,
      unrenderableFiles: 0,
    });
    expect(result.files[0]).toMatchObject({
      path: "src/a.ts",
      additions: 2,
      deletions: 1,
      size: "normal",
      isBinary: false,
      hasHiddenBidiChars: false,
    });
  });

  it("classifies binary diffs as unrenderable", () => {
    const result = analyzeReviewDiff(
      [
        "diff --git a/assets/icon.png b/assets/icon.png",
        "index 1111111..2222222 100644",
        "Binary files a/assets/icon.png and b/assets/icon.png differ",
      ].join("\n"),
    );

    expect(result.files[0]?.isBinary).toBe(true);
    expect(result.files[0]?.size).toBe("unrenderable");
    expect(result.metadata.unrenderableFiles).toBe(1);
  });

  it("flags very long lines and hidden bidi characters", () => {
    const result = analyzeReviewDiff(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        `+${"x".repeat(5_001)}\u202E`,
      ].join("\n"),
    );

    expect(result.files[0]?.size).toBe("large");
    expect(result.files[0]?.hasHiddenBidiChars).toBe(true);
    expect(result.metadata.largeFiles).toBe(1);
  });
});
