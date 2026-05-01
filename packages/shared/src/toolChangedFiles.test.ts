import { describe, expect, it } from "vitest";

import {
  buildInlineUnifiedDiffPreview,
  extractChangedFilePathCandidatesFromToolPayload,
  extractNormalizedChangedFilePathsFromToolPayload,
  normalizeChangedFilePath,
} from "./toolChangedFiles.ts";

describe("tool changed file paths", () => {
  it("extracts changed file path candidates from known provider payload fields", () => {
    expect(
      extractChangedFilePathCandidatesFromToolPayload({
        data: {
          path: "src/a.ts",
          filePath: "src/b.ts",
          relativePath: "src/c.ts",
          filename: "README.md",
          newPath: "src/new.ts",
          oldPath: "src/old.ts",
        },
      }),
    ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "README.md", "src/new.ts", "src/old.ts"]);
  });

  it("recurses through supported nested provider payload containers", () => {
    expect(
      extractChangedFilePathCandidatesFromToolPayload({
        item: { input: { files: [{ path: "src/input.ts" }] } },
        result: { changes: [{ filePath: "src/result.ts" }] },
        data: { operations: [{ edits: [{ newPath: "src/edit.ts" }] }] },
      }),
    ).toEqual(["src/input.ts", "src/result.ts", "src/edit.ts"]);
  });

  it("deduplicates candidates after Unicode NFC normalization", () => {
    expect(
      extractChangedFilePathCandidatesFromToolPayload({
        files: [{ path: "cafe\u0301.ts" }, { filePath: "café.ts" }],
      }),
    ).toEqual(["café.ts"]);
  });

  it("bounds recursion depth, visited nodes, and accepted path count", () => {
    const deepPayload = {
      data: {
        data: {
          data: {
            path: "too-deep.ts",
          },
        },
      },
    };
    expect(extractChangedFilePathCandidatesFromToolPayload(deepPayload, { maxDepth: 1 })).toEqual(
      [],
    );

    expect(
      extractChangedFilePathCandidatesFromToolPayload(
        {
          files: [{ path: "one.ts" }, { path: "two.ts" }, { path: "three.ts" }],
        },
        { maxPaths: 2 },
      ),
    ).toEqual(["one.ts", "two.ts"]);

    expect(
      extractChangedFilePathCandidatesFromToolPayload(
        {
          files: [{ path: "one.ts" }, { path: "two.ts" }],
        },
        { maxNodes: 2 },
      ),
    ).toEqual([]);
  });

  it("normalizes safe relative paths", () => {
    expect(normalizeChangedFilePath("./src\\app.ts")).toBe("src/app.ts");
    expect(normalizeChangedFilePath("src/../src/app.ts")).toBe("src/app.ts");
    expect(normalizeChangedFilePath("cafe\u0301.ts")).toBe("café.ts");
    expect(normalizeChangedFilePath("-leading-dash.ts")).toBe("-leading-dash.ts");
  });

  it("converts absolute paths under cwd to repository-relative paths", () => {
    expect(
      normalizeChangedFilePath("/repo/project/src/app.ts", {
        cwd: "/repo/project",
      }),
    ).toBe("src/app.ts");
  });

  it("rejects unsafe paths", () => {
    expect(normalizeChangedFilePath("")).toBeNull();
    expect(normalizeChangedFilePath("../outside.ts")).toBeNull();
    expect(normalizeChangedFilePath("src/../../outside.ts")).toBeNull();
    expect(normalizeChangedFilePath("src/\napp.ts")).toBeNull();
    expect(normalizeChangedFilePath("src/\u0000app.ts")).toBeNull();
    expect(normalizeChangedFilePath(":(glob)src/*.ts")).toBeNull();
    expect(normalizeChangedFilePath(":!src/secret.ts")).toBeNull();
    expect(normalizeChangedFilePath("/repo/project/src/app.ts")).toBeNull();
    expect(normalizeChangedFilePath("/repo/other/src/app.ts", { cwd: "/repo/project" })).toBeNull();
    expect(normalizeChangedFilePath("C:\\repo\\project\\src\\app.ts")).toBeNull();
  });

  it("extracts paths from embedded apply_patch text in rawInput", () => {
    expect(
      extractNormalizedChangedFilePathsFromToolPayload(
        {
          data: {
            rawInput:
              "*** Begin Patch\n*** Add File: /repo/project/story5.md\n+Line 1\n+Line 2\n*** End Patch\n",
          },
        },
        { cwd: "/repo/project", maxPaths: 10 },
      ),
    ).toEqual(["story5.md"]);
  });

  it("extracts old and new paths from apply_patch Move/Rename headers", () => {
    expect(
      extractNormalizedChangedFilePathsFromToolPayload(
        {
          data: {
            rawInput: "*** Begin Patch\n*** Move File: src/old.ts -> src/new.ts\n*** End Patch\n",
          },
        },
        { maxPaths: 10 },
      ),
    ).toEqual(["src/old.ts", "src/new.ts"]);
  });

  it("builds an inline diff preview that keeps hunk headers, drops noise, and injects a per-file header", () => {
    expect(
      buildInlineUnifiedDiffPreview(
        [
          "diff --git a/src/app.ts b/src/app.ts",
          "index 123..456 100644",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1,4 +1,4 @@ function run() {",
          " const value = 1;",
          "-oldCall();",
          "+newCall();",
          " }",
        ].join("\n"),
      ),
    ).toEqual({
      lines: [
        "File: src/app.ts",
        "@@ -1,4 +1,4 @@ function run() {",
        " const value = 1;",
        "-oldCall();",
        "+newCall();",
        " }",
      ],
      truncated: false,
    });
  });

  it("preserves blank context lines (single-space lines) inside hunks", () => {
    expect(
      buildInlineUnifiedDiffPreview(
        ["diff --git a/src/app.ts b/src/app.ts", "@@ -1,5 +1,6 @@", " a", " ", "+b", " c"].join(
          "\n",
        ),
      ),
    ).toEqual({
      lines: ["File: src/app.ts", "@@ -1,5 +1,6 @@", " a", " ", "+b", " c"],
      truncated: false,
    });
  });

  it("emits a File header for every diff --git boundary in a multi-file diff", () => {
    const preview = buildInlineUnifiedDiffPreview(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "@@ -1 +1 @@",
        "-aa",
        "+ab",
        "diff --git a/src/b.ts b/src/b.ts",
        "@@ -1 +1 @@",
        "-bb",
        "+bc",
      ].join("\n"),
    );
    expect(preview?.lines).toEqual([
      "File: src/a.ts",
      "@@ -1 +1 @@",
      "-aa",
      "+ab",
      "File: src/b.ts",
      "@@ -1 +1 @@",
      "-bb",
      "+bc",
    ]);
    expect(preview?.truncated).toBe(false);
  });

  it("strips the no-newline-at-end-of-file marker", () => {
    expect(
      buildInlineUnifiedDiffPreview(
        [
          "diff --git a/a.ts b/a.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
          "\\ No newline at end of file",
        ].join("\n"),
      )?.lines,
    ).toEqual(["File: a.ts", "@@ -1 +1 @@", "-a", "+b"]);
  });

  it("reports inline diff preview truncation after header injection", () => {
    expect(
      buildInlineUnifiedDiffPreview("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b", {
        maxLines: 2,
      }),
    ).toEqual({ lines: ["File: a.ts", "@@ -1 +1 @@"], truncated: true });
  });
});
