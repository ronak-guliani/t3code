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
  writeFileMock,
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
  readFileMock: vi.fn(
    async (): Promise<{ relativePath: string; contents: string; binary?: boolean }> => ({
      relativePath: "src/index.ts",
      contents: "export const covered = true;",
    }),
  ),
  writeFileMock: vi.fn(async () => ({ relativePath: "src/index.ts" })),
  createAssetUrlMock: vi.fn(async () => ({ relativeUrl: "/assets/signed" })),
}));

vi.mock("~/environmentApi", () => ({
  ensureEnvironmentApi: vi.fn(() => ({
    projects: { listEntries: listEntriesMock, readFile: readFileMock, writeFile: writeFileMock },
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
import { getProjectFileSaveSession } from "./projectFileSaveSession";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-files"),
  ThreadId.make("thread-files"),
);

describe("FilePreviewPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows a detached save failure after reopening and retries without reindexing", async () => {
    const cwd = "/repo/reopen-failed-save";
    const relativePath = "src/index.ts";
    const session = getProjectFileSaveSession(threadRef.environmentId, cwd, relativePath);
    let fail!: (cause: Error) => void;
    writeFileMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const props = { cwd, relativePath, threadRef, onOpenFile: vi.fn() };
    const first = await render(<FilePreviewPanel {...props} />);
    await expect.element(page.getByText("export const covered = true;")).toBeInTheDocument();
    session.change("export const retained = true;");
    await first.unmount();
    await vi.waitFor(() => expect(writeFileMock).toHaveBeenCalledTimes(1));
    fail(new Error("permission denied"));
    await vi.waitFor(() => expect(session.getSnapshot().error).toBe("permission denied"));

    const reopened = await render(<FilePreviewPanel {...props} />);
    try {
      await expect.element(page.getByText("Save failed: permission denied")).toBeInTheDocument();
      await expect.element(page.getByText("export const retained = true;")).toBeInTheDocument();
      const indexReads = listEntriesMock.mock.calls.length;
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await vi.waitFor(() => expect(writeFileMock).toHaveBeenCalledTimes(2));
      await expect
        .element(page.getByText("Save failed: permission denied"))
        .not.toBeInTheDocument();
      expect(listEntriesMock).toHaveBeenCalledTimes(indexReads);
    } finally {
      await reopened.unmount();
    }
    expect(writeFileMock).toHaveBeenCalledTimes(2);
  });

  it("constrains long file scrolling to the retained panel height", async () => {
    readFileMock.mockResolvedValueOnce({
      relativePath: "long.ts",
      contents: Array.from({ length: 500 }, (_, index) => `const line${index} = ${index};`).join(
        "\n",
      ),
    });
    const screen = await render(
      <div style={{ height: 400, width: 700, overflow: "hidden" }}>
        <div className="h-full min-h-0">
          <FilePreviewPanel
            cwd="/repo/long-file"
            relativePath="long.ts"
            threadRef={threadRef}
            onOpenFile={vi.fn()}
          />
        </div>
      </div>,
    );
    try {
      await vi.waitFor(() => {
        const viewport = document.querySelector(".file-preview-virtualizer");
        expect(viewport).not.toBeNull();
        expect(viewport!.clientHeight).toBeGreaterThan(0);
        expect(viewport!.clientHeight).toBeLessThan(400);
        expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);
      });
    } finally {
      await screen.unmount();
    }
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

  it("renders binary images as image previews", async () => {
    readFileMock.mockResolvedValueOnce({
      relativePath: "assets/logo.png",
      contents: "",
      binary: true,
    });
    const screen = await render(
      <FilePreviewPanel
        cwd="/repo/binary-preview"
        relativePath="assets/logo.png"
        threadRef={threadRef}
        onOpenFile={vi.fn()}
      />,
    );
    try {
      await expect.element(page.getByRole("img", { name: "assets/logo.png" })).toBeInTheDocument();
      expect(createAssetUrlMock).toHaveBeenCalledWith({
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: "assets/logo.png",
        },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("renders unsupported binary files as read-only notices", async () => {
    readFileMock.mockResolvedValueOnce({
      relativePath: "assets/archive.bin",
      contents: "",
      binary: true,
    });
    const screen = await render(
      <FilePreviewPanel
        cwd="/repo/binary-preview"
        relativePath="assets/archive.bin"
        threadRef={threadRef}
        onOpenFile={vi.fn()}
      />,
    );
    try {
      await expect
        .element(page.getByText("This binary file cannot be previewed or edited as text."))
        .toBeInTheDocument();
      expect(page.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
