import "../../index.css";

import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const {
  openFileInPreviewMock,
  openPreviewMock,
  listEntriesMock,
  readFileMock,
  createAssetUrlMock,
} = vi.hoisted(() => ({
  openFileInPreviewMock: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  openPreviewMock: vi.fn(),
  listEntriesMock: vi.fn(async () => ({
    entries: [
      { path: "src", kind: "directory" as const },
      { path: "src/index.ts", kind: "file" as const, parentPath: "src" },
    ],
    truncated: false,
  })),
  readFileMock: vi.fn(async () => ({
    relativePath: "src/index.ts",
    contents: "export const covered = true;",
  })),
  createAssetUrlMock: vi.fn(async () => ({ relativeUrl: "/assets/signed" })),
}));

vi.mock("~/environmentApi", () => ({
  ensureEnvironmentApi: vi.fn(() => ({
    projects: { listEntries: listEntriesMock, readFile: readFileMock, writeFile: vi.fn() },
    assets: { createUrl: createAssetUrlMock },
  })),
}));

vi.mock("~/environments/runtime", () => ({
  getEnvironmentHttpBaseUrl: vi.fn(() => "http://localhost:3773"),
}));

vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: vi.fn(() => true),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: vi.fn(() => openPreviewMock),
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: { open: {} },
}));

vi.mock("~/browser/openFileInPreview", () => ({
  isBrowserPreviewFile: (path: string) => /\.(?:html?|pdf)$/i.test(path),
  openFileInPreview: openFileInPreviewMock,
}));

import { FilePreviewPanel } from "./FilePreviewPanel";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-files"),
  ThreadId.make("thread-files"),
);

describe("FilePreviewPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the workspace tree", async () => {
    const screen = await render(
      <FilePreviewPanel
        cwd="/caller/cannot-control-this"
        relativePath={null}
        threadRef={threadRef}
        onOpenFile={vi.fn()}
      />,
    );
    try {
      await vi.waitFor(() => {
        expect(listEntriesMock).toHaveBeenCalledWith({
          cwd: "/caller/cannot-control-this",
        });
        expect(document.querySelector("[data-file-browser-panel]")).not.toBeNull();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("renders text files and promotes HTML/PDF files into the browser", async () => {
    const screen = await render(
      <FilePreviewPanel
        cwd="/repo/project"
        relativePath="src/index.ts"
        threadRef={threadRef}
        onOpenFile={vi.fn()}
      />,
    );
    try {
      await expect.element(page.getByText("export const covered = true;")).toBeInTheDocument();
      expect(readFileMock).toHaveBeenCalledWith({
        cwd: "/repo/project",
        relativePath: "src/index.ts",
      });

      await screen.rerender(
        <FilePreviewPanel
          cwd="/repo/project"
          relativePath="reports/result.pdf"
          threadRef={threadRef}
          onOpenFile={vi.fn()}
        />,
      );
      await page.getByRole("button", { name: "Open in browser" }).click();
      expect(openFileInPreviewMock).toHaveBeenCalledWith(
        expect.objectContaining({
          threadRef,
          relativePath: "reports/result.pdf",
          httpBaseUrl: "http://localhost:3773",
          createAssetUrl: createAssetUrlMock,
          openPreview: openPreviewMock,
        }),
      );
    } finally {
      await screen.unmount();
    }
  });
});
