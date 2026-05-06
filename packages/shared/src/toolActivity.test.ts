import { describe, expect, it } from "vitest";

import { deriveToolActivityPresentation } from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("describes Copilot edit tools with a file count and path preview", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "file_change",
        title: "Edit",
        data: {
          kind: "edit",
          rawInput: {
            filePath: "src/app.ts",
          },
        },
        fallbackSummary: "Edit",
      }),
    ).toEqual({
      summary: "Edited 1 file",
      detail: "src/app.ts",
    });
  });

  it("describes multi-file edits without implying line-level changes", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "file_change",
        title: "MultiEdit",
        data: {
          kind: "edit",
          changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" }],
        },
        fallbackSummary: "MultiEdit",
      }),
    ).toEqual({
      summary: "Edited 3 files",
      detail: "src/a.ts +2 more",
    });
  });

  it("describes created and deleted files from apply_patch headers", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "file_change",
        title: "apply_patch",
        data: {
          rawInput:
            "*** Begin Patch\n*** Add File: src/new.ts\n+export const value = 1;\n*** End Patch\n",
        },
        fallbackSummary: "apply_patch",
      }),
    ).toEqual({
      summary: "Created file",
      detail: "src/new.ts",
    });

    expect(
      deriveToolActivityPresentation({
        itemType: "file_change",
        title: "apply_patch",
        data: {
          rawInput: "*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch\n",
        },
        fallbackSummary: "apply_patch",
      }),
    ).toEqual({
      summary: "Deleted file",
      detail: "src/old.ts",
    });
  });

  it("describes renamed files with old and new paths", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "file_change",
        title: "Move",
        data: {
          kind: "move",
          rawInput: {
            oldPath: "src/old.ts",
            newPath: "src/new.ts",
          },
        },
        fallbackSummary: "Move",
      }),
    ).toEqual({
      summary: "Renamed file",
      detail: "src/old.ts -> src/new.ts",
    });
  });

  it("keeps a clear file-change fallback when Copilot omits paths", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "file_change",
        title: "Edit",
        data: {
          kind: "edit",
        },
        fallbackSummary: "Edit",
      }),
    ).toEqual({
      summary: "Edited files",
    });
  });
});
