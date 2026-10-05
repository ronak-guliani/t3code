import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  applyPreviewSnapshotMock,
  isPreviewAvailable,
  openPreviewSessionMock,
  readPreviewState,
  rememberPreviewUrlMock,
} = vi.hoisted(() => ({
  applyPreviewSnapshotMock: vi.fn(),
  isPreviewAvailable: vi.fn(() => true),
  openPreviewSessionMock: vi.fn(),
  readPreviewState: vi.fn(() => ({ sessions: {} })),
  rememberPreviewUrlMock: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: applyPreviewSnapshotMock,
  isPreviewSupportedInRuntime: isPreviewAvailable,
  readThreadPreviewState: readPreviewState,
  rememberPreviewUrl: rememberPreviewUrlMock,
}));
vi.mock("~/components/preview/openPreviewSession", () => ({
  openPreviewSession: openPreviewSessionMock,
}));

import { openFileReference } from "./openFileReference";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

const threadRef = scopeThreadRef(
  EnvironmentId.make("reference-environment"),
  ThreadId.make("reference-thread"),
);
const openPreview = vi.fn();
const navigatePreview = vi.fn();
const createAssetUrl = vi.fn();
const textMetadata = {
  name: "report.ts",
  mimeType: "text/plain",
  sizeBytes: 12,
  viewMode: "text" as const,
};

function fileInput(path: string, cwd = "/repo/project") {
  return {
    threadRef,
    filePath: path,
    cwd,
    httpBaseUrl: "https://environment.example",
    createAssetUrl,
    openPreview,
    navigatePreview,
  };
}

describe("openFileReference", () => {
  afterEach(() => {
    vi.clearAllMocks();
    createAssetUrl.mockReset();
    useRightPanelStore.setState({ byThreadKey: {} });
    readPreviewState.mockReturnValue({ sessions: {} });
    isPreviewAvailable.mockReturnValue(true);
  });

  it("opens external text in a read-only reference surface with source position", async () => {
    createAssetUrl.mockResolvedValueOnce({
      relativeUrl: "/api/assets/signed/positioned-report.ts",
      expiresAt: Date.now() + 300_000,
      fileReference: textMetadata,
    });

    await openFileReference({ ...fileInput("/tmp/positioned-report.ts"), line: 4, column: 7 });
    await openFileReference({ ...fileInput("/tmp/positioned-report.ts"), line: 8, column: 7 });

    expect(createAssetUrl).toHaveBeenCalledWith({
      resource: {
        _tag: "referenced-file",
        threadId: threadRef.threadId,
        path: "/tmp/positioned-report.ts",
        line: 4,
        column: 7,
      },
    });
    expect(createAssetUrl).toHaveBeenCalledTimes(1);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toMatchObject([
      {
        kind: "file",
        relativePath: "/tmp/positioned-report.ts",
        revealLine: 8,
        revealColumn: 7,
        reference: { kind: "external", path: "/tmp/positioned-report.ts", line: 8, column: 7 },
      },
    ]);
    expect(openPreviewSessionMock).not.toHaveBeenCalled();
  });

  it("opens workspace text through the existing guarded editable file path", async () => {
    createAssetUrl.mockResolvedValueOnce({
      relativeUrl: "/api/assets/signed/index.ts",
      expiresAt: Date.now() + 300_000,
      fileReference: { ...textMetadata, name: "index.ts" },
    });

    await openFileReference(fileInput("/repo/project/src/index.ts"));

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([
      {
        id: "file:src/index.ts",
        kind: "file",
        relativePath: "src/index.ts",
        revealLine: null,
      },
    ]);
    expect(openPreviewSessionMock).not.toHaveBeenCalled();
  });

  it.each([
    { path: "src/index.ts", relativePath: "src/index.ts" },
    { path: "/repo/project/README", relativePath: "README" },
    { path: "/repo/project/Dockerfile", relativePath: "Dockerfile" },
    { path: "/repo/project/src/component.vue", relativePath: "src/component.vue" },
  ])(
    "opens workspace path $path in the guarded editable viewer",
    async ({ path, relativePath }) => {
      createAssetUrl.mockResolvedValueOnce({
        relativeUrl: "/api/assets/signed/workspace-file",
        expiresAt: Date.now() + 300_000,
        fileReference: {
          ...textMetadata,
          name: relativePath.split("/").at(-1) ?? relativePath,
          viewMode: "download",
        },
      });

      await openFileReference(fileInput(path));

      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
      ).toEqual([
        {
          id: `file:${relativePath}`,
          kind: "file",
          relativePath,
          revealLine: null,
        },
      ]);
      expect(createAssetUrl).not.toHaveBeenCalled();
    },
  );

  it("renews an expired external text grant without adding another panel", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    createAssetUrl
      .mockResolvedValueOnce({
        relativeUrl: "/api/assets/old/notes.ts",
        expiresAt: now + 100,
        fileReference: textMetadata,
      })
      .mockResolvedValueOnce({
        relativeUrl: "/api/assets/new/notes.ts",
        expiresAt: 310_000,
        fileReference: textMetadata,
      });
    try {
      await openFileReference(fileInput("/tmp/expired-notes.ts"));
      now += 1_000;
      await openFileReference(fileInput("/tmp/expired-notes.ts"));
      const panel = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      );
      expect(createAssetUrl).toHaveBeenCalledTimes(2);
      expect(panel.surfaces).toHaveLength(1);
      expect(panel.surfaces[0]).toMatchObject({
        id: "file-reference:/tmp/expired-notes.ts",
        reference: { assetExpiresAt: 310_000 },
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("uses a sandboxed file-reference surface when the integrated browser is unavailable", async () => {
    isPreviewAvailable.mockReturnValue(false);
    createAssetUrl.mockResolvedValueOnce({
      relativeUrl: "/api/assets/signed/report.html",
      expiresAt: Date.now() + 300_000,
      fileReference: {
        name: "report.html",
        mimeType: "text/html",
        sizeBytes: 64,
        viewMode: "html",
      },
    });

    await openFileReference(fileInput("/tmp/report.html"));

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toMatchObject([
      {
        kind: "file",
        reference: {
          kind: "external",
          path: "/tmp/report.html",
          metadata: { viewMode: "html" },
        },
      },
    ]);
    expect(openPreviewSessionMock).not.toHaveBeenCalled();
  });

  it("keeps SVG references in the inert image viewer instead of navigating them as documents", async () => {
    createAssetUrl.mockResolvedValueOnce({
      relativeUrl: "/api/assets/signed/chart.svg",
      expiresAt: Date.now() + 300_000,
      fileReference: {
        name: "chart.svg",
        mimeType: "image/svg+xml",
        sizeBytes: 64,
        viewMode: "media",
      },
    });

    await openFileReference(fileInput("/tmp/chart.svg"));

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toMatchObject([
      {
        kind: "file",
        reference: { kind: "external", path: "/tmp/chart.svg", metadata: { viewMode: "media" } },
      },
    ]);
    expect(openPreviewSessionMock).not.toHaveBeenCalled();
  });

  it("resolves attachment references through the shared boundary for the existing gallery", async () => {
    const onOpenGallery = vi.fn();
    const attachments = [
      { id: "thread-ref-a", name: "a.png", mimeType: "image/png" },
      { id: "thread-ref-b", name: "b.png", mimeType: "image/png" },
    ];
    createAssetUrl
      .mockResolvedValueOnce({ relativeUrl: "/assets/a", expiresAt: Date.now() + 300_000 })
      .mockResolvedValueOnce({ relativeUrl: "/assets/b", expiresAt: Date.now() + 300_000 });

    await openFileReference({
      kind: "attachments",
      threadRef,
      httpBaseUrl: "https://environment.example",
      attachments,
      selectedAttachmentId: "thread-ref-b",
      createAssetUrl,
      onOpenGallery,
    });

    expect(createAssetUrl).toHaveBeenNthCalledWith(1, {
      resource: {
        _tag: "attachment",
        attachmentId: "thread-ref-a",
        fileName: "a.png",
        mimeType: "image/png",
        disposition: "inline",
      },
    });
    expect(onOpenGallery).toHaveBeenCalledWith(
      [
        {
          id: "thread-ref-a",
          name: "a.png",
          mimeType: "image/png",
          previewUrl: "https://environment.example/assets/a",
        },
        {
          id: "thread-ref-b",
          name: "b.png",
          mimeType: "image/png",
          previewUrl: "https://environment.example/assets/b",
        },
      ],
      "thread-ref-b",
    );
  });

  it("preserves an already-hydrated attachment gallery without requiring another environment request", async () => {
    const onOpenGallery = vi.fn();
    const attachments = [
      { id: "thread-ref-a", name: "a.png", mimeType: "image/png", previewUrl: "https://assets/a" },
      { id: "thread-ref-b", name: "b.png", mimeType: "image/png", previewUrl: "https://assets/b" },
    ];

    await openFileReference({
      kind: "attachments",
      threadRef,
      attachments,
      selectedAttachmentId: "thread-ref-b",
      onOpenGallery,
    });

    expect(createAssetUrl).not.toHaveBeenCalled();
    expect(onOpenGallery).toHaveBeenCalledWith(attachments, "thread-ref-b");
  });

  it("reuses one live preview tab for repeated references to the same path", async () => {
    const snapshot = {
      tabId: "tab-live-report",
      updatedAt: "2026-01-01T00:00:00.000Z",
      navStatus: { _tag: "Loading", url: "https://environment.example/report.html" },
    };
    openPreviewSessionMock.mockResolvedValue({ _tag: "Success", value: snapshot });
    createAssetUrl.mockResolvedValue({
      relativeUrl: "/api/assets/signed/live-report.html",
      expiresAt: Date.now() + 300_000,
      fileReference: {
        ...textMetadata,
        name: "live-report.html",
        mimeType: "text/html",
        viewMode: "html",
      },
    });
    readPreviewState.mockReturnValue({ sessions: { "tab-live-report": snapshot } });

    await openFileReference(fileInput("/tmp/live-report.html"));
    await openFileReference(fileInput("/tmp/live-report.html"));

    expect(createAssetUrl).toHaveBeenCalledTimes(1);
    expect(openPreviewSessionMock).toHaveBeenCalledTimes(1);
    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
    expect(panel.surfaces.filter((surface) => surface.kind === "preview")).toHaveLength(1);
  });

  it("refreshes an expired grant by navigating the existing preview tab", async () => {
    const tabId = "tab-expiring-report";
    const snapshot = {
      tabId,
      updatedAt: "2026-01-01T00:00:00.000Z",
      navStatus: { _tag: "Loading", url: "https://environment.example/old" },
    };
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    openPreviewSessionMock.mockResolvedValue({ _tag: "Success", value: snapshot });
    navigatePreview.mockResolvedValue({
      _tag: "Success",
      value: {
        ...snapshot,
        navStatus: { _tag: "Loading", url: "https://environment.example/new" },
      },
    });
    createAssetUrl
      .mockResolvedValueOnce({
        relativeUrl: "/api/assets/old/expired-report.html",
        expiresAt: now + 100,
        fileReference: {
          name: "expired-report.html",
          mimeType: "text/html",
          sizeBytes: 32,
          viewMode: "html",
        },
      })
      .mockResolvedValueOnce({
        relativeUrl: "/api/assets/new/expired-report.html",
        expiresAt: now + 300_000,
        fileReference: {
          name: "expired-report.html",
          mimeType: "text/html",
          sizeBytes: 32,
          viewMode: "html",
        },
      });
    readPreviewState.mockReturnValue({ sessions: { [tabId]: snapshot } });

    try {
      await openFileReference(fileInput("/tmp/expired-report.html"));
      now += 1_000;
      await openFileReference(fileInput("/tmp/expired-report.html"));
      expect(createAssetUrl).toHaveBeenCalledTimes(2);
      expect(openPreviewSessionMock).toHaveBeenCalledTimes(1);
      expect(navigatePreview).toHaveBeenCalledWith({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          tabId,
          url: "https://environment.example/api/assets/new/expired-report.html",
        },
      });
    } finally {
      vi.restoreAllMocks();
    }
  });
});
