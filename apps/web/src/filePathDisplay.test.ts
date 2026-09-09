import { describe, expect, it } from "vitest";

import { formatWorkspaceRelativePath, toWorkspaceRelativePath } from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("formats absolute workspace paths from the workspace root", () => {
    expect(
      formatWorkspaceRelativePath(
        "C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("prefixes relative paths with the workspace root label", () => {
    expect(
      formatWorkspaceRelativePath(
        "apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("keeps paths already rooted at the workspace label stable", () => {
    expect(
      formatWorkspaceRelativePath(
        "t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("preserves columns when present", () => {
    expect(
      formatWorkspaceRelativePath(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501:9",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501:9");
  });
});

describe("toWorkspaceRelativePath", () => {
  it("resolves dot segments inside workspace paths", () => {
    expect(toWorkspaceRelativePath("/repo/project/./report.html", "/repo/project")).toBe(
      "report.html",
    );
  });

  it("returns nested relative paths", () => {
    expect(toWorkspaceRelativePath("/repo/project/src/index.ts", "/repo/project")).toBe(
      "src/index.ts",
    );
  });

  it("returns null for files outside the workspace", () => {
    expect(toWorkspaceRelativePath("/Users/other/project/outside.ts", "/repo/project")).toBeNull();
  });

  it("is case-sensitive on POSIX so mismatches fall back to the editor", () => {
    expect(toWorkspaceRelativePath("/repo/Project/a.ts", "/repo/project")).toBeNull();
  });

  it("is case-insensitive for Windows drive paths", () => {
    expect(toWorkspaceRelativePath("C:\\Repo\\Project\\src\\a.ts", "c:\\repo\\project")).toBe(
      "src/a.ts",
    );
  });

  it("rejects mixed absolute path flavors", () => {
    expect(toWorkspaceRelativePath("/repo/project/a.ts", "\\\\repo\\project")).toBeNull();
    expect(toWorkspaceRelativePath("C:\\repo\\project\\a.ts", "/repo/project")).toBeNull();
  });

  it("does not resolve dot segments above a Windows drive anchor", () => {
    expect(toWorkspaceRelativePath("C:\\..\\project\\a.ts", "C:\\project")).toBe("a.ts");
    expect(toWorkspaceRelativePath("D:\\..\\project\\a.ts", "C:\\project")).toBeNull();
  });

  it("supports a Windows drive-root workspace", () => {
    expect(toWorkspaceRelativePath("C:\\src\\a.ts", "C:\\")).toBe("src/a.ts");
  });

  it("does not resolve dot segments above a UNC share anchor", () => {
    expect(
      toWorkspaceRelativePath("\\\\server\\other\\..\\project\\src\\a.ts", "\\\\server\\project"),
    ).toBeNull();
    expect(
      toWorkspaceRelativePath("\\\\server\\project\\..\\src\\a.ts", "\\\\server\\src"),
    ).toBeNull();
  });

  it("preserves the POSIX filesystem root", () => {
    expect(toWorkspaceRelativePath("/src/index.ts", "/")).toBe("src/index.ts");
  });

  it("returns null without a workspace root", () => {
    expect(toWorkspaceRelativePath("/repo/project/src/index.ts", undefined)).toBeNull();
  });
});
