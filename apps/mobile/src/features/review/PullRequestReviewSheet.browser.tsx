import type { GitListOpenPullRequestsResult, GitResolvedPullRequest } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentQueryView } from "../../state/query";
import { PullRequestReviewSheet } from "./PullRequestReviewSheet";

const mocks = vi.hoisted(() => ({
  platform: { OS: "ios" },
  connected: true,
  openPullRequests: vi.fn(() => "pull-requests"),
  refresh: vi.fn(),
  runWorkflow: vi.fn(),
  prewarm: vi.fn(),
  goBack: vi.fn(),
  dispatch: vi.fn(),
}));

let query: EnvironmentQueryView<GitListOpenPullRequestsResult>;

vi.mock("react-native", () => ({
  Platform: mocks.platform,
  Alert: { alert: vi.fn() },
  View: ({ children }: { children?: ReactNode }) => <div data-native-view>{children}</div>,
  ActivityIndicator: () => <div role="progressbar" />,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  RefreshControl: ({ onRefresh }: { onRefresh: () => void }) => (
    <button onClick={onRefresh}>Refresh</button>
  ),
  FlatList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
    refreshControl,
  }: {
    data: GitResolvedPullRequest[];
    renderItem: (info: { item: GitResolvedPullRequest }) => ReactNode;
    ListHeaderComponent: ReactNode;
    ListEmptyComponent: ReactNode;
    refreshControl: ReactNode;
  }) => (
    <main data-native-scroll-view>
      {ListHeaderComponent}
      {refreshControl}
      {data.length === 0
        ? ListEmptyComponent
        : data.map((item) => <section key={item.number}>{renderItem({ item })}</section>)}
    </main>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: mocks.goBack, dispatch: mocks.dispatch }),
  StackActions: { popTo: (name: string, params: unknown) => ({ name, params }) },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 24, left: 0 }),
}));
vi.mock("../../components/AndroidScreenHeader", () => ({
  AndroidSheetHeader: ({ title, onBack }: { title: string; onBack: () => void }) => (
    <header>
      {title}
      <button onClick={onBack}>Back</button>
    </header>
  ),
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "review-request" }));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => ({ id: "child" }) },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellAtom: vi.fn() },
}));
vi.mock("../../state/review", () => ({
  reviewEnvironment: {
    openPullRequests: mocks.openPullRequests,
    prewarmChangesContext: mocks.prewarm,
    runWorkflow: mocks.runWorkflow,
  },
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { status: () => "git-status" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === "git-status"
      ? { data: { isRepo: true }, error: null, isPending: false, refresh: vi.fn() }
      : query,
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/repo" }),
}));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: {
      id: "parent",
      environmentId: "local",
      modelSelection: { instanceId: "copilot", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    selectedThreadProject: { id: "project" },
    selectedEnvironmentRuntime: {
      connectionState: mocks.connected ? "connected" : "disconnected",
      serverConfig: {
        environment: { capabilities: { agentWorkflows: true } },
        settings: {
          agentWorkflows: { reviewChanges: { enabled: true }, builtInOverrides: {} },
        },
      },
    },
  }),
}));

const pullRequest: GitResolvedPullRequest = {
  number: 42,
  title: "Fix review drawer",
  url: "https://github.com/example/repo/pull/42",
  baseBranch: "main",
  headBranch: "fix-review",
  state: "open",
};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.platform.OS = "ios";
  mocks.connected = true;
  query = { data: null, error: null, isPending: true, refresh: mocks.refresh };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    root.render(
      <PullRequestReviewSheet
        route={{
          params: { environmentId: "local", threadId: "parent" },
        }}
      />,
    );
  });
}

describe("review sheet content and native host contract (not native geometry)", () => {
  it("keeps the iOS list at the root while loading and after results arrive", async () => {
    await render();
    const scrollView = container.firstElementChild;
    expect(scrollView?.hasAttribute("data-native-scroll-view")).toBe(true);
    expect(container.textContent).toContain("Review pull request");
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(container.textContent).not.toContain("No open pull requests");

    query = { ...query, data: { pullRequests: [pullRequest] }, isPending: false };
    await render();
    expect(container.firstElementChild).toBe(scrollView);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).toContain("#42 Fix review drawer");
    expect(container.textContent).toContain("fix-review → main");
    expect(mocks.openPullRequests).toHaveBeenCalledWith({
      environmentId: "local",
      input: { cwd: "/repo" },
    });
  });

  it.each([
    { error: null, message: "No open pull requests were found for this repository." },
    { error: "GitHub request failed.", message: "GitHub request failed." },
  ])("shows a visible empty/error state: $message", async ({ error, message }) => {
    query = { ...query, data: { pullRequests: [] }, error, isPending: false };
    await render();
    expect(container.firstElementChild?.hasAttribute("data-native-scroll-view")).toBe(true);
    expect(container.textContent).toContain(message);
    await act(async () => container.querySelector("button")?.click());
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("explains when the environment is disconnected instead of querying PRs", async () => {
    mocks.connected = false;
    query = { ...query, isPending: false };
    await render();
    expect(container.textContent).toContain("Connect to the environment to review a pull request.");
    expect(mocks.openPullRequests).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();
  });

  it("starts the selected review and navigates to its child chat", async () => {
    mocks.runWorkflow.mockResolvedValue({
      _tag: "Success",
      value: { status: "started", threadId: "child" },
    });
    query = { ...query, data: { pullRequests: [pullRequest] }, isPending: false };
    await render();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label^="Review pull request 42"]')
        ?.click();
    });
    expect(mocks.runWorkflow).toHaveBeenCalledWith({
      environmentId: "local",
      input: expect.objectContaining({
        threadId: "parent",
        cwd: "/repo",
        input: { scope: "pull-request", pullRequestNumber: 42 },
        idempotencyKey: "review-request",
        destinationMode: "child-chat",
      }),
    });
    expect(mocks.dispatch).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "local", threadId: "child" },
    });
  });

  it("preserves the Android page header and back action above the list", async () => {
    mocks.platform.OS = "android";
    await render();
    const page = container.firstElementChild;
    expect(page?.hasAttribute("data-native-view")).toBe(true);
    expect(page?.firstElementChild?.tagName).toBe("HEADER");
    expect(page?.lastElementChild?.hasAttribute("data-native-scroll-view")).toBe(true);
    await act(async () =>
      container
        .querySelector("header button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(mocks.goBack).toHaveBeenCalledOnce();
  });
});
