import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fileChipMenu, fileChipShareSource, resolveFileChipTarget } from "./fileChipMenu";

describe("resolveFileChipTarget", () => {
  it("resolves a workspace-relative link to both paths", () => {
    expect(resolveFileChipTarget("src/app.ts:12", "/repo")).toEqual({
      fullPath: "/repo/src/app.ts",
      relativePath: "src/app.ts",
    });
  });

  it("keeps only the full path for a host file outside the workspace", () => {
    expect(resolveFileChipTarget("/tmp/report.md", "/repo")).toEqual({
      fullPath: "/tmp/report.md",
    });
  });

  it("keeps only the relative path when the workspace root is unknown", () => {
    expect(resolveFileChipTarget("src/app.ts", null)).toEqual({ relativePath: "src/app.ts" });
  });

  it("ignores links that are not files or cannot be opened", () => {
    expect(resolveFileChipTarget("https://example.com/app.ts", "/repo")).toBeNull();
    expect(resolveFileChipTarget("~/report.md", "/repo")).toBeNull();
    expect(resolveFileChipTarget("../other/file.ts", "/repo")).toBeNull();
  });
});

describe("fileChipMenu", () => {
  it("offers only the copies the target can satisfy", () => {
    expect(fileChipMenu({ fullPath: "/tmp/report.md" })).toEqual({
      title: "/tmp/report.md",
      actions: [
        { id: "copy-full-path", title: "Copy full path" },
        { id: "open-file", title: "Open in file viewer" },
      ],
    });
    expect(fileChipMenu({ relativePath: "src/app.ts" }).actions.map(({ id }) => id)).toEqual([
      "copy-relative-path",
      "open-file",
    ]);
  });
});

describe("file chip downloads", () => {
  const threadId = ThreadId.make("thread-1");

  it.each([
    ["clips/demo.mp4", "clips/demo.mp4", "video/mp4"],
    ["screens/image.PNG", "screens/image.PNG", "image/png"],
  ])("offers a workspace download for %s", (href, path, mimeType) => {
    const target = resolveFileChipTarget(href, "/repo")!;
    expect(fileChipMenu(target).actions).toContainEqual({
      id: "save",
      title: "Save or share",
    });
    expect(fileChipShareSource(target, threadId)).toEqual({
      name: path.split("/").at(-1),
      mimeType,
      resource: { _tag: "media-file", threadId, path },
    });
  });

  it("retains the thread context for a relative file without a known workspace root", () => {
    expect(
      fileChipShareSource(resolveFileChipTarget("clips/demo.mp4", null)!, threadId),
    ).toMatchObject({
      resource: { _tag: "media-file", threadId, path: "clips/demo.mp4" },
    });
  });

  it("does not offer downloads the host asset endpoint cannot serve", () => {
    for (const href of ["src/app.ts", "/tmp/report.pdf", "/tmp/clip.mp4", "/tmp/clip.mp4.txt"]) {
      const target = resolveFileChipTarget(href, "/repo")!;
      expect(fileChipShareSource(target, threadId)).toBeNull();
      expect(fileChipMenu(target).actions.some(({ id }) => id === "save")).toBe(false);
    }
  });
});
