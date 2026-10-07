import "../index.css";

import { Profiler } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

const {
  createAssetUrlMock,
  openFileReferenceMock,
  openBrowserMock,
  openFileMock,
  openInPreferredEditorMock,
  openPreviewMock,
  navigateMock,
  readLocalApiMock,
} = vi.hoisted(() => ({
  createAssetUrlMock: vi.fn(async () => ({ relativeUrl: "/assets/signed" })),
  openFileReferenceMock: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  openBrowserMock: vi.fn(),
  openFileMock: vi.fn(),
  openInPreferredEditorMock: vi.fn(async () => "vscode"),
  openPreviewMock: vi.fn(),
  navigateMock: vi.fn(async () => undefined),
  readLocalApiMock: vi.fn(),
}));

readLocalApiMock.mockImplementation(() => ({
  server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
  shell: { openInEditor: vi.fn(async () => undefined) },
  persistence: {
    getClientSettings: vi.fn(async () => ({ browserLinkTarget: "app" as const })),
    setClientSettings: vi.fn(async () => undefined),
  },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigateMock,
}));

vi.mock("../editorPreferences", () => ({
  openInPreferredEditor: openInPreferredEditorMock,
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: readLocalApiMock,
  readLocalApi: readLocalApiMock,
}));

vi.mock("../environmentApi", () => ({
  readEnvironmentApi: vi.fn(() => ({
    assets: { createUrl: createAssetUrlMock },
  })),
  ensureEnvironmentApi: vi.fn(() => ({
    assets: { createUrl: createAssetUrlMock },
  })),
}));

vi.mock("./files/projectFilesQueryState", () => ({
  useProjectEntriesQuery: vi.fn(() => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })),
  useProjectFileQuery: vi.fn(() => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })),
}));

vi.mock("../environments/runtime", () => ({
  getEnvironmentHttpBaseUrl: vi.fn(() => "http://localhost:3773"),
  resolveEnvironmentHttpUrl: vi.fn((_environmentId: string, path: string) => path),
}));

vi.mock("../environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../environments/primary")>()),
  usePrimaryEnvironmentId: () => null,
}));

vi.mock("../previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  isPreviewSupportedInRuntime: vi.fn(() => true),
  rememberPreviewUrl: vi.fn(),
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: vi.fn(() => openPreviewMock),
}));

vi.mock("../state/preview", () => ({
  previewEnvironment: { open: {} },
}));

vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({
      openBrowser: openBrowserMock,
      openFile: openFileMock,
      openExternalFile: vi.fn(),
    }),
  },
}));

vi.mock("../browser/openFileReference", () => ({
  isBrowserPreviewFile: (path: string) => /\.(?:html?|pdf)$/i.test(path),
  openFileReference: openFileReferenceMock,
}));

import ChatMarkdown from "./ChatMarkdown";
import { selectEnvironmentState, useStore } from "../store";
import { INTERNAL_PULL_REQUEST_NAVIGATION_EVENT } from "../lib/openPullRequestLink";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-markdown"),
  ThreadId.make("thread-markdown"),
);
const initialStoreState = useStore.getState();

function addThreadSummary(
  threadId: ThreadId,
  title: string,
  pullRequest?: {
    readonly number: number;
    readonly url: string;
  },
) {
  const state = useStore.getState();
  const environmentState = selectEnvironmentState(state, threadRef.environmentId);
  useStore.setState({
    environmentStateById: {
      ...state.environmentStateById,
      [threadRef.environmentId]: {
        ...environmentState,
        threadShellById: {
          ...environmentState.threadShellById,
          [threadId]: {
            id: threadId,
            environmentId: threadRef.environmentId,
            codexThreadId: null,
            projectId: ProjectId.make("project-markdown"),
            parentThreadId: null,
            title,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
            },
            runtimeMode: "full-access",
            pendingRuntimeMode: null,
            interactionMode: "default",
            error: null,
            createdAt: "2026-07-31T00:00:00.000Z",
            archivedAt: null,
            branch: null,
            worktreePath: null,
            ...(pullRequest
              ? {
                  pullRequest: {
                    number: pullRequest.number,
                    title,
                    url: pullRequest.url,
                    baseBranch: "main",
                    headBranch: "feature",
                    state: "open" as const,
                  },
                }
              : {}),
          },
        },
        sidebarThreadSummaryById: {
          ...environmentState.sidebarThreadSummaryById,
          [threadId]: {
            id: threadId,
            environmentId: threadRef.environmentId,
            projectId: ProjectId.make("project-markdown"),
            parentThreadId: null,
            title,
            interactionMode: "default",
            session: null,
            createdAt: "2026-07-31T00:00:00.000Z",
            archivedAt: null,
            latestTurn: null,
            branch: null,
            worktreePath: null,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
            hasPendingQueuedTurn: false,
            ...(pullRequest
              ? {
                  pullRequest: {
                    number: pullRequest.number,
                    title: title,
                    url: pullRequest.url,
                    baseBranch: "main",
                    headBranch: "feature",
                    state: "open" as const,
                  },
                }
              : {}),
          },
        },
      },
    },
  });
}

describe("ChatMarkdown", () => {
  afterEach(() => {
    useStore.setState(initialStoreState, true);
    openInPreferredEditorMock.mockClear();
    openFileReferenceMock.mockClear();
    openFileMock.mockClear();
    openPreviewMock.mockClear();
    navigateMock.mockClear();
    createAssetUrlMock.mockClear();
    readLocalApiMock.mockClear();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("retains completed prose paragraphs while streaming the active paragraph", async () => {
    const firstText = "Opening **statement**";
    const renderMarkdown = (text: string, isStreaming: boolean) => (
      <ChatMarkdown text={text} cwd="/repo/project" isStreaming={isStreaming} />
    );
    const screen = await render(renderMarkdown(firstText, true));

    try {
      await expect.element(page.getByText("Opening statement")).toBeVisible();

      const nextText = `${firstText}\n\nSecond *paragraph*`;
      await screen.rerender(renderMarkdown(nextText, true));
      await expect.element(page.getByText("Second paragraph")).toBeVisible();
      expect(document.querySelectorAll(".chat-markdown > p")).toHaveLength(2);
      expect(document.querySelector(".chat-markdown > p strong")?.textContent).toBe("statement");
      expect(document.querySelector(".chat-markdown > p em")?.textContent).toBe("paragraph");

      await screen.rerender(renderMarkdown(nextText, false));
      await expect.element(page.getByText("Second paragraph")).toBeVisible();
      expect(document.querySelectorAll(".chat-markdown > p")).toHaveLength(2);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps reference links, task lists, and fences on the full Markdown parser path", async () => {
    const text = [
      "[pull request][pr]",
      "",
      "[pr]: https://github.com/owner/repo/pull/42",
      "",
      "- [ ] Keep this task",
      "",
      "```ts",
      "const answer = 42;",
      "```",
    ].join("\n");
    const screen = await render(<ChatMarkdown text={text} cwd="/repo/project" isStreaming />);

    try {
      const link = page.getByRole("link", { name: "pull request" });
      await expect.element(link).toHaveAttribute("href", "https://github.com/owner/repo/pull/42");
      expect(document.querySelector('input[type="checkbox"]')).not.toBeNull();
      expect(document.querySelector(".chat-markdown-codeblock code")?.textContent?.trim()).toBe(
        "const answer = 42;",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("navigates thread references within the current environment", async () => {
    const linkedThreadId = "bc880b45-fd48-42db-98fa-f211bae7cc0a";
    const uppercaseThreadId = linkedThreadId.toUpperCase();
    addThreadSummary(ThreadId.make(linkedThreadId), "Finish PR review fixes");
    const screen = await render(
      <ChatMarkdown
        text={`Created replacement thread: \`${uppercaseThreadId}\``}
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "Open thread Finish PR review fixes" });
      await expect.element(link).toHaveTextContent("Finish PR review fixes");
      await expect.element(link).not.toHaveTextContent(linkedThreadId);
      await link.click();
      await vi.waitFor(() => {
        expect(navigateMock).toHaveBeenCalledWith({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: threadRef.environmentId,
            threadId: linkedThreadId,
          },
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("rewrites file uri hrefs into direct paths before rendering", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown
        text={`[PermissionRule.ts](file://${filePath})`}
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", filePath);

      await link.click();

      await vi.waitFor(() => {
        expect(openFileReferenceMock).toHaveBeenCalledWith(
          expect.objectContaining({ threadRef, cwd: "/repo/project", filePath }),
        );
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps line anchors working after rewriting file uri hrefs", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown
        text={`[PermissionRule.ts:1](file://${filePath}#L1)`}
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}:1`);

      await link.click();

      await vi.waitFor(() => {
        expect(openFileReferenceMock).toHaveBeenCalledWith(
          expect.objectContaining({ threadRef, cwd: "/repo/project", filePath, line: 1 }),
        );
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("shows column information inline when present", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown
        text={`[PermissionRule.ts](file://${filePath}#L1C7)`}
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1:C7" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}:1:7`);

      await link.click();

      await vi.waitFor(() => {
        expect(openFileReferenceMock).toHaveBeenCalledWith(
          expect.objectContaining({
            threadRef,
            cwd: "/repo/project",
            filePath,
            line: 1,
            column: 7,
          }),
        );
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("disambiguates duplicate file basenames inline", async () => {
    const firstPath = "/Users/yashsingh/p/t3code/apps/web/src/components/chat/MessagesTimeline.tsx";
    const secondPath = "/Users/yashsingh/p/t3code/apps/web/src/components/MessagesTimeline.tsx";
    const screen = await render(
      <ChatMarkdown
        text={`See [MessagesTimeline.tsx](file://${firstPath}) and [MessagesTimeline.tsx](file://${secondPath}).`}
        cwd="/repo/project"
      />,
    );

    try {
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · components/chat" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · src/components" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("opens normal web links in the integrated browser", async () => {
    openPreviewMock.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        threadId: threadRef.threadId,
        tabId: "tab-web-link",
        navStatus: {
          _tag: "Loading",
          url: "https://openai.com/docs",
          title: "",
        },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    });
    const screen = await render(
      <ChatMarkdown
        text="[OpenAI](https://openai.com/docs)"
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "OpenAI" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", "https://openai.com/docs");
      await expect.element(link).toHaveAttribute("target", "_blank");
      await link.click();
      await vi.waitFor(() => {
        expect(openPreviewMock).toHaveBeenCalledWith({
          environmentId: threadRef.environmentId,
          input: expect.objectContaining({
            threadId: threadRef.threadId,
            url: "https://openai.com/docs",
          }),
        });
        expect(openBrowserMock).toHaveBeenCalledWith(threadRef, "tab-web-link");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("navigates explicit T3 thread links internally instead of opening preview", async () => {
    const linkedThreadId = ThreadId.make("bc880b45-fd48-42db-98fa-f211bae7cc0a");
    addThreadSummary(linkedThreadId, "Replacement thread");
    const screen = await render(
      <ChatMarkdown
        text={`[new thread](${globalThis.location.origin}/${threadRef.environmentId}/${linkedThreadId})`}
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "Open thread new thread" });
      await expect
        .element(link)
        .toHaveAttribute("href", `/${threadRef.environmentId}/${linkedThreadId}`);
      await link.click();
      await vi.waitFor(() => {
        expect(navigateMock).toHaveBeenCalledWith({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: threadRef.environmentId,
            threadId: linkedThreadId,
          },
        });
      });
      expect(openPreviewMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("navigates reference-style T3 thread links internally instead of opening preview", async () => {
    const linkedThreadId = ThreadId.make("bc880b45-fd48-42db-98fa-f211bae7cc0a");
    addThreadSummary(linkedThreadId, "Replacement thread");
    const screen = await render(
      <ChatMarkdown
        text={`[new thread][child]\n\n[child]: /${threadRef.environmentId}/${linkedThreadId}`}
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "Open thread new thread" });
      await expect
        .element(link)
        .toHaveAttribute("href", `/${threadRef.environmentId}/${linkedThreadId}`);
      await link.click();
      await vi.waitFor(() => {
        expect(navigateMock).toHaveBeenCalledWith({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: threadRef.environmentId,
            threadId: linkedThreadId,
          },
        });
      });
      expect(openPreviewMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    "http://127.0.0.1:3773",
    "http://localhost:4773",
    "http://[::1]:4773",
    "http://10.0.0.237:3773",
    "http://192.168.1.25:4773",
    "http://[fd00::25]:4773",
  ])("navigates local thread links from %s inside the app", async (origin) => {
    const linkedThreadId = ThreadId.make("bc880b45-fd48-42db-98fa-f211bae7cc0a");
    addThreadSummary(linkedThreadId, "Replacement thread");
    const screen = await render(
      <ChatMarkdown
        text={`[replacement thread](${origin}/${threadRef.environmentId}/${linkedThreadId})`}
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "Open thread replacement thread" });
      await expect
        .element(link)
        .toHaveAttribute("href", `/${threadRef.environmentId}/${linkedThreadId}`);
      await expect.element(link).not.toHaveAttribute("target");
      await link.click();
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: threadRef.environmentId, threadId: linkedThreadId },
      });
      expect(openPreviewMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("routes reference-style pull request links through internal navigation", async () => {
    const eventHandler = vi.fn();
    window.addEventListener(INTERNAL_PULL_REQUEST_NAVIGATION_EVENT, eventHandler);
    addThreadSummary(threadRef.threadId, "Current thread", {
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
    });
    const screen = await render(
      <ChatMarkdown
        text={"[pull request][pr]\n\n[pr]: https://github.com/owner/repo/pull/42"}
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "pull request" });
      await expect.element(link).toHaveAttribute("href", "https://github.com/owner/repo/pull/42");
      await link.click();
      await vi.waitFor(() => {
        expect(eventHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            detail: expect.objectContaining({
              host: "github.com",
              repository: "owner/repo",
              number: 42,
              url: "https://github.com/owner/repo/pull/42",
            }),
          }),
        );
      });
      expect(openPreviewMock).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(INTERNAL_PULL_REQUEST_NAVIGATION_EVENT, eventHandler);
      await screen.unmount();
    }
  });

  it("routes context-qualified GitHub shorthand through internal navigation", async () => {
    const eventHandler = vi.fn();
    window.addEventListener(INTERNAL_PULL_REQUEST_NAVIGATION_EVENT, eventHandler);
    addThreadSummary(threadRef.threadId, "Current thread", {
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
    });
    const screen = await render(
      <ChatMarkdown
        text="See owner/repo#42 for the related change."
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "owner/repo#42" });
      await expect.element(link).toHaveAttribute("href", "https://github.com/owner/repo/pull/42");
      await link.click();
      await vi.waitFor(() => {
        expect(eventHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            detail: expect.objectContaining({
              host: "github.com",
              repository: "owner/repo",
              number: 42,
              url: "https://github.com/owner/repo/pull/42",
            }),
          }),
        );
      });
      expect(openPreviewMock).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(INTERNAL_PULL_REQUEST_NAVIGATION_EVENT, eventHandler);
      await screen.unmount();
    }
  });

  it("keeps PR URLs with query strings or fragments on the external-link path", async () => {
    openPreviewMock.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        threadId: threadRef.threadId,
        tabId: "tab-pr-discussion",
        navStatus: {
          _tag: "Loading",
          url: "https://github.com/owner/repo/pull/42?tab=files#discussion_r1",
          title: "",
        },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    });
    const eventHandler = vi.fn();
    window.addEventListener(INTERNAL_PULL_REQUEST_NAVIGATION_EVENT, eventHandler);
    const url = "https://github.com/owner/repo/pull/42?tab=files#discussion_r1";
    const screen = await render(
      <ChatMarkdown text={`[discussion](${url})`} cwd="/repo/project" threadRef={threadRef} />,
    );

    try {
      const link = page.getByRole("link", { name: "discussion" });
      await expect.element(link).toHaveAttribute("href", url);
      await expect.element(link).toHaveAttribute("target", "_blank");
      await link.click();
      await vi.waitFor(() => {
        expect(openPreviewMock).toHaveBeenCalledWith({
          environmentId: threadRef.environmentId,
          input: expect.objectContaining({
            threadId: threadRef.threadId,
            url,
          }),
        });
      });
      expect(eventHandler).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(INTERNAL_PULL_REQUEST_NAVIGATION_EVENT, eventHandler);
      await screen.unmount();
    }
  });

  it("does not re-render historical Markdown for unrelated environment-state updates", async () => {
    const commits: Array<number> = [];
    addThreadSummary(threadRef.threadId, "Historical thread");
    const screen = await render(
      <Profiler id="historical-markdown" onRender={() => commits.push(Date.now())}>
        <ChatMarkdown text="Historical message" cwd="/repo/project" threadRef={threadRef} />
      </Profiler>,
    );

    try {
      await vi.waitFor(() => expect(commits.length).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const initialCommitCount = commits.length;
      const state = useStore.getState();
      const environmentState = selectEnvironmentState(state, threadRef.environmentId);
      useStore.setState({
        environmentStateById: {
          ...state.environmentStateById,
          [threadRef.environmentId]: {
            ...environmentState,
            bootstrapComplete: !environmentState.bootstrapComplete,
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(commits).toHaveLength(initialCommitCount);
    } finally {
      await screen.unmount();
    }
  });

  it("reports a streaming Markdown performance baseline", async () => {
    const samples: number[] = [];
    let text = "";
    const paragraphCount = 16;
    const screen = await render(
      <ChatMarkdown text={text} cwd="/repo/project" isStreaming threadRef={threadRef} />,
    );

    try {
      for (let index = 0; index < paragraphCount; index += 1) {
        const paragraph = `Streaming paragraph ${index} with ordinary prose.`;
        const nextText = `${text}${text.length > 0 ? "\n\n" : ""}${paragraph}`;
        const startedAt = performance.now();
        await screen.rerender(
          <ChatMarkdown
            text={nextText}
            cwd="/repo/project"
            isStreaming
            threadRef={threadRef}
          />,
        );
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(
            () => reject(new Error(`Streaming paragraph ${index} did not render.`)),
            5_000,
          );
          const check = () => {
            if (document.body.textContent?.includes(paragraph)) {
              window.clearTimeout(timeout);
              resolve();
              return;
            }
            window.requestAnimationFrame(check);
          };
          check();
        });
        if (index >= 2) {
          samples.push(performance.now() - startedAt);
        }
        text = nextText;
      }

      const sortedSamples = samples.toSorted((left, right) => left - right);
      const medianMs = sortedSamples[Math.floor(sortedSamples.length / 2)] ?? 0;
      const p95Ms = sortedSamples[Math.ceil(sortedSamples.length * 0.95) - 1] ?? 0;
      console.warn(
        JSON.stringify({
          benchmark: "streaming-markdown",
          appendedParagraphs: paragraphCount,
          measuredChunks: samples.length,
          medianMs: Number(medianMs.toFixed(2)),
          p95Ms: Number(p95Ms.toFixed(2)),
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("keeps table headers from inheriting emergency word breaks", async () => {
    const screen = await render(
      <ChatMarkdown
        text={[
          "| Rank | Finding | Impact / effort |",
          "| --- | --- | --- |",
          "| 1 | Every event fans out to every projection. | Very high / medium |",
        ].join("\n")}
        cwd="/repo/project"
      />,
    );

    try {
      await vi.waitFor(() => {
        const header = [...document.querySelectorAll("th")].find(
          (candidate) => candidate.textContent?.trim() === "Rank",
        );
        expect(header).toBeInstanceOf(HTMLTableCellElement);
        expect(getComputedStyle(header!).overflowWrap).not.toBe("anywhere");
      });
    } finally {
      await screen.unmount();
    }
  });

  it.each(["report.html", "report.pdf"])(
    "opens linked %s files in the integrated browser",
    async (fileName) => {
      const screen = await render(
        <ChatMarkdown
          text={`[${fileName}](./${fileName})`}
          cwd="/repo/project"
          threadRef={threadRef}
        />,
      );

      try {
        await page.getByRole("link", { name: fileName }).click();
        await vi.waitFor(() => {
          expect(openFileReferenceMock).toHaveBeenCalledWith({
            threadRef,
            filePath: `/repo/project/./${fileName}`,
            cwd: "/repo/project",
            httpBaseUrl: "http://localhost:3773",
            createAssetUrl: createAssetUrlMock,
            openPreview: openPreviewMock,
            navigatePreview: openPreviewMock,
          });
        });
        expect(openInPreferredEditorMock).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("strips source positions from integrated browser preview paths", async () => {
    const screen = await render(
      <ChatMarkdown
        text="[report.html](./report.html#L12)"
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      await page.getByRole("link", { name: "report.html · L12" }).click();
      await vi.waitFor(() => {
        expect(openFileReferenceMock).toHaveBeenCalledWith({
          threadRef,
          filePath: "/repo/project/./report.html",
          cwd: "/repo/project",
          line: 12,
          httpBaseUrl: "http://localhost:3773",
          createAssetUrl: createAssetUrlMock,
          openPreview: openPreviewMock,
          navigatePreview: openPreviewMock,
        });
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("opens workspace files in the integrated file browser", async () => {
    const screen = await render(
      <ChatMarkdown
        text="[index.ts](./src/index.ts#L12)"
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      await page.getByRole("link", { name: "index.ts · L12" }).click();
      await vi.waitFor(() => {
        expect(openFileReferenceMock).toHaveBeenCalledWith(
          expect.objectContaining({
            threadRef,
            cwd: "/repo/project",
            filePath: expect.any(String),
            line: 12,
          }),
        );
      });
      expect(openFileMock).not.toHaveBeenCalled();
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("opens inline code file mentions in the integrated file browser", async () => {
    const screen = await render(
      <ChatMarkdown
        text="See `src/index.ts:40` for details"
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      await page.getByRole("link", { name: "index.ts · L40" }).click();
      await vi.waitFor(() => {
        expect(openFileReferenceMock).toHaveBeenCalledWith(
          expect.objectContaining({ threadRef, cwd: "/repo/project", line: 40 }),
        );
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("opens bare basename mentions in the integrated file browser", async () => {
    const screen = await render(
      <ChatMarkdown
        text="See `CopilotProvider.ts:103` for details"
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      await page.getByRole("link", { name: "CopilotProvider.ts · L103" }).click();
      await vi.waitFor(() => {
        expect(openFileReferenceMock).toHaveBeenCalledWith(
          expect.objectContaining({ threadRef, cwd: "/repo/project", line: 103 }),
        );
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("opens comma-separated line lists at the first line", async () => {
    const screen = await render(
      <ChatMarkdown
        text="See `settings.ts:542,733` for details"
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      await page.getByRole("link", { name: "settings.ts · L542,733" }).click();
      await vi.waitFor(() => {
        expect(openFileReferenceMock).toHaveBeenCalledWith(
          expect.objectContaining({ threadRef, cwd: "/repo/project", line: 542 }),
        );
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("opens external text references through the owning environment, never the local editor", async () => {
    const filePath = "/tmp/External notes.txt";
    const captureDirectory = import.meta.env.VITE_FILE_REFERENCE_CAPTURE_DIR;
    if (captureDirectory) await page.viewport(1280, 800);
    const screen = await render(
      <ChatMarkdown
        text="See [External notes](file:///tmp/External%20notes.txt)"
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      if (captureDirectory) {
        await page.screenshot({ path: `${captureDirectory}/external-file-before.png` });
      }
      await page.getByRole("link", { name: "External notes" }).click();
      await vi.waitFor(() => {
        expect(openFileReferenceMock).toHaveBeenCalledWith({
          threadRef,
          filePath,
          cwd: "/repo/project",
          httpBaseUrl: "http://localhost:3773",
          createAssetUrl: createAssetUrlMock,
          openPreview: openPreviewMock,
          navigatePreview: openPreviewMock,
        });
      });
      expect(openFileMock).not.toHaveBeenCalled();
      expect(openFileReferenceMock).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("never sends an absolute remote reference without an owning thread to the local editor", async () => {
    const screen = await render(
      <ChatMarkdown text="[outside](file:///tmp/outside.ts)" cwd="/repo/project" />,
    );
    try {
      await page.getByRole("link", { name: "outside" }).click();
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
      expect(readLocalApiMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("decodes Unicode file URLs once and preserves both line and column", async () => {
    const filePath = "/tmp/Quarterly report café.ts";
    const screen = await render(
      <ChatMarkdown
        text="[Quarterly report](file:///tmp/Quarterly%20report%20caf%C3%A9.ts#L5C3)"
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );
    try {
      await page.getByRole("link", { name: /Quarterly report/ }).click();
      await vi.waitFor(() => {
        expect(openFileReferenceMock).toHaveBeenCalledWith(
          expect.objectContaining({
            threadRef,
            cwd: "/repo/project",
            filePath,
            line: 5,
            column: 3,
          }),
        );
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
