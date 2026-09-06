import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CompactThreadRow } from "./compact-thread-row";
import {
  buildMobileThreadTree,
  mobileThreadTreeRows,
  type MobileThreadShell,
} from "./mobile-thread-hierarchy";

interface TestProps {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  numberOfLines?: number;
  onPress?: () => void;
  onAccessibilityTap?: () => void;
}
const harness = vi.hoisted(() => ({
  pressables: [] as TestProps[],
  menus: [] as TestProps[],
  unread: false,
  navigate: vi.fn(),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
  View: ({ children }: TestProps) => createElement("div", null, children),
  Pressable: (props: TestProps) => {
    harness.pressables.push(props);
    return createElement("button", { "aria-label": props.accessibilityLabel }, props.children);
  },
}));
vi.mock("../../components/AppText", () => ({
  AppText: (props: TestProps) =>
    createElement("span", { "data-lines": props.numberOfLines }, props.children),
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ControlPill", () => ({
  ControlPillMenu: (props: TestProps) => {
    harness.menus.push(props);
    return createElement("section", { "data-menu": true }, props.children);
  },
}));
vi.mock("../../lib/use-app-navigation", () => ({
  useAppNavigation: () => ({ navigate: harness.navigate }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("./thread-hierarchy-controls", () => ({
  useUnreadChildNotification: () => harness.unread,
}));
vi.mock("./thread-search-match", () => ({
  ThreadSearchMatchExcerpt: () => createElement("aside", null, "Matched excerpt"),
}));

const parent: MobileThreadShell = {
  environmentId: EnvironmentId.make("local"),
  id: ThreadId.make("parent"),
  projectId: ProjectId.make("project"),
  title: "Parent chat",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: "hidden-branch",
  worktreePath: "/hidden-checkout",
  latestTurn: null,
  createdAt: "2026-09-06T10:00:00Z",
  updatedAt: "2026-09-06T10:00:00Z",
  archivedAt: null,
  session: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasPendingQueuedTurn: false,
  hasActionableProposedPlan: false,
};

beforeEach(() => {
  harness.pressables.length = 0;
  harness.menus.length = 0;
  harness.unread = false;
  harness.navigate.mockClear();
});

describe("compact inbox row", () => {
  it("keeps related navigation outside the primary context menu and preserves activation", () => {
    const onPress = vi.fn();
    const hierarchy = mobileThreadTreeRows(
      buildMobileThreadTree([
        parent,
        {
          ...parent,
          id: ThreadId.make("child"),
          parentThreadId: parent.id,
          hasPendingApprovals: true,
        },
      ]),
    )[0]!;
    harness.unread = true;
    const markup = renderToStaticMarkup(
      <CompactThreadRow
        title={parent.title}
        timestamp="2m"
        status="ready"
        onPress={onPress}
        menu={{ actions: [] }}
        related={{ thread: parent, hierarchy }}
      />,
    );
    expect(markup).not.toContain("Child update");
    expect(markup).not.toContain(parent.branch);
    expect(markup).not.toContain(parent.worktreePath);
    expect(markup).toContain('data-lines="1"');
    expect(renderToStaticMarkup(harness.menus[0]?.children)).not.toContain("Related chats");
    expect(renderToStaticMarkup(harness.menus[0]?.children)).toContain(">2m<");
    expect(harness.menus[0]?.accessibilityLabel).toBe("Parent chat, 2m");
    harness.menus[0]?.onAccessibilityTap?.();
    expect(onPress).toHaveBeenCalledOnce();
    const related = harness.pressables.find((item) =>
      item.accessibilityLabel?.startsWith("Related chats"),
    );
    expect(related?.accessibilityLabel).toContain("unread activity");
    expect(related?.accessibilityLabel).toContain("needs approval in group");
    related?.onPress?.();
    expect(harness.navigate).toHaveBeenCalledWith("RelatedThreads", {
      environmentId: "local",
      threadId: "parent",
    });
  });

  it("does not repeat the parent's status on quiet related chats", () => {
    const working = { ...parent, hasPendingQueuedTurn: true };
    const hierarchy = mobileThreadTreeRows(
      buildMobileThreadTree([
        working,
        { ...parent, id: ThreadId.make("child"), parentThreadId: parent.id },
      ]),
    )[0]!;
    renderToStaticMarkup(
      <CompactThreadRow
        title={parent.title}
        timestamp="2m"
        status="working"
        onPress={() => {}}
        related={{ thread: working, hierarchy }}
      />,
    );
    expect(harness.pressables[0]?.accessibilityLabel).toContain("Working");
    expect(harness.pressables[1]?.accessibilityLabel).not.toContain("working in group");
  });

  it("includes the timestamp and search excerpt in the primary tap and long-press target", () => {
    const onPress = vi.fn();
    renderToStaticMarkup(
      <CompactThreadRow
        title={parent.title}
        timestamp="2m"
        status="ready"
        onPress={onPress}
        menu={{ actions: [] }}
        searchMatch={{
          environmentId: parent.environmentId,
          threadId: parent.id,
          projectId: parent.projectId,
          source: "user",
          snippet: "Needle",
          messageCreatedAt: parent.createdAt,
        }}
      />,
    );
    const content = renderToStaticMarkup(harness.pressables[0]?.children);
    expect(content).toContain(">2m<");
    expect(content).toContain("Matched excerpt");
    expect(renderToStaticMarkup(harness.menus[0]?.children)).toContain("Matched excerpt");
    expect(harness.menus[0]?.accessibilityLabel).toContain("You: Needle");
    harness.pressables[0]?.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it.each(["working", "approval", "input", "failed", "queued", "plan-ready"] as const)(
    "announces %s without adding routine status text",
    (status) => {
      const markup = renderToStaticMarkup(
        <CompactThreadRow title="Chat" timestamp="1m" status={status} onPress={() => {}} />,
      );
      expect(harness.pressables[0]?.accessibilityLabel).not.toBe("Chat, 1m");
      if (status === "working") expect(markup).not.toContain(">Working<");
      expect(harness.pressables).toHaveLength(1);
    },
  );

  it("keeps unread group activity reachable when the last related chat disappears", () => {
    harness.unread = true;
    renderToStaticMarkup(
      <CompactThreadRow
        title={parent.title}
        timestamp="1m"
        status="ready"
        onPress={() => {}}
        related={{ thread: parent }}
      />,
    );
    expect(harness.pressables[1]?.accessibilityLabel).toContain("unread activity");
  });
});
