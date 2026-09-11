import { describe, expect, it } from "vite-plus/test";

import { collapseBreadcrumbs, fileBreadcrumbs } from "./filePath";

describe("fileBreadcrumbs", () => {
  it("builds project, directory, and file crumbs", () => {
    expect(fileBreadcrumbs("t3code", "apps/web/src/main.tsx")).toEqual([
      { label: "t3code", path: "", kind: "project" },
      { label: "apps", path: "apps", kind: "directory" },
      { label: "web", path: "apps/web", kind: "directory" },
      { label: "src", path: "apps/web/src", kind: "directory" },
      { label: "main.tsx", path: "apps/web/src/main.tsx", kind: "file" },
    ]);
  });

  it("normalizes repeated separators", () => {
    expect(fileBreadcrumbs("workspace", "/src//index.ts").map((crumb) => crumb.label)).toEqual([
      "workspace",
      "src",
      "index.ts",
    ]);
  });

  it("supports windows separators", () => {
    expect(fileBreadcrumbs("workspace", "apps\\web\\src\\main.tsx")).toEqual([
      { label: "workspace", path: "", kind: "project" },
      { label: "apps", path: "apps", kind: "directory" },
      { label: "web", path: "apps/web", kind: "directory" },
      { label: "src", path: "apps/web/src", kind: "directory" },
      { label: "main.tsx", path: "apps/web/src/main.tsx", kind: "file" },
    ]);
  });
});

describe("collapseBreadcrumbs", () => {
  it("keeps short trails intact", () => {
    const crumbs = fileBreadcrumbs("t3code", "src/main.tsx");
    expect(collapseBreadcrumbs(crumbs)).toEqual(crumbs);
  });

  it("collapses deep trails to project, ellipsis, parent, and file", () => {
    const crumbs = fileBreadcrumbs("t3code", "packages/contracts/src/background.test.ts");
    expect(collapseBreadcrumbs(crumbs)).toEqual([
      { label: "t3code", path: "", kind: "project" },
      { label: "…", path: "", kind: "ellipsis" },
      { label: "src", path: "packages/contracts/src", kind: "directory" },
      {
        label: "background.test.ts",
        path: "packages/contracts/src/background.test.ts",
        kind: "file",
      },
    ]);
  });
});
