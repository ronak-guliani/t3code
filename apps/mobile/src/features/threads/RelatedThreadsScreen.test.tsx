import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RelatedThreadsScreen } from "./RelatedThreadsScreen";
import type { MobileThreadShell, MobileThreadTreeRow } from "./mobile-thread-hierarchy";
import type { ThreadListRow } from "./thread-list-items";
import type { ThreadListV2Row } from "./thread-list-v2-items";

const harness = vi.hoisted(() => ({
  threads: [] as MobileThreadShell[],
  rows: [] as ComponentProps<typeof ThreadListV2Row>[],
  legacyRows: [] as ComponentProps<typeof ThreadListRow>[],
  v2: true,
  capabilities: {
    threadSettlement: true,
    threadSnooze: true,
    threadPinning: true,
    threadPinReorder: true,
    threadTitleRegeneration: true,
  },
  actions: {
    archiveThread: vi.fn(),
    confirmDeleteThread: vi.fn(),
    regenerateThreadTitle: vi.fn(),
    settleThread: vi.fn(),
    unsettleThread: vi.fn(),
    snoozeThread: vi.fn(),
    unsnoozeThread: vi.fn(),
    pinThread: vi.fn(),
    unpinThread: vi.fn(),
    moveThread: vi.fn(),
  },
  markRead: vi.fn(),
  openParent: vi.fn(),
  dismissAgentRun: vi.fn(),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
  useFocusEffect: () => {},
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Pressable: ({ children }: { children: ReactNode }) => createElement("button", null, children),
  useWindowDimensions: () => ({ width: 402 }),
  FlatList: (props: {
    data: MobileThreadTreeRow[];
    renderItem: (input: { item: MobileThreadTreeRow; index: number }) => ReactNode;
  }) =>
    createElement(
      "div",
      null,
      props.data.map((item, index) =>
        createElement("section", { key: item.threadKey }, props.renderItem({ item, index })),
      ),
    ),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => createElement("span", null, children),
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../state/entities", () => ({
  useThreadShells: () => harness.threads,
  useServerConfigs: () =>
    new Map([
      [EnvironmentId.make("local"), { environment: { capabilities: harness.capabilities } }],
    ]),
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("./thread-hierarchy-controls", () => ({
  useDismissedAgentRunKeys: () => [],
  useMarkThreadGroupNotificationsRead: (rows: MobileThreadTreeRow[]) => harness.markRead(rows),
}));
vi.mock("./use-thread-list-v2-enabled", () => ({ useThreadListV2Enabled: () => harness.v2 }));
vi.mock("../home/useThreadListActions", () => ({ useThreadListActions: () => harness.actions }));
vi.mock("./use-nested-thread-actions", () => ({
  useNestedThreadActions: () => ({
    actions: [],
    handleAction: () => {},
    openParent: harness.openParent,
    dismissAgentRun: harness.dismissAgentRun,
  }),
}));
vi.mock("./thread-list-items", () => ({
  ThreadListRow: (props: ComponentProps<typeof ThreadListRow>) => {
    harness.legacyRows.push(props);
    return null;
  },
}));
vi.mock("./thread-list-v2-items", () => ({
  ThreadListV2Row: (props: ComponentProps<typeof ThreadListV2Row>) => {
    harness.rows.push(props);
    return null;
  },
}));

const parent: MobileThreadShell = {
  environmentId: EnvironmentId.make("local"),
  id: ThreadId.make("parent"),
  projectId: ProjectId.make("project"),
  title: "Parent",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-09-06T10:00:00.000Z",
  updatedAt: "2026-09-06T10:00:00.000Z",
  archivedAt: null,
  snoozedUntil: null,
  session: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasPendingQueuedTurn: false,
  hasActionableProposedPlan: false,
};
const child = { ...parent, id: ThreadId.make("child"), title: "Child", parentThreadId: parent.id };
function render(threadId = parent.id) {
  renderToStaticMarkup(
    <RelatedThreadsScreen route={{ params: { environmentId: "local", threadId } }} />,
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T20:00:00.000Z"));
  harness.threads = [parent, child];
  harness.rows.length = 0;
  harness.legacyRows.length = 0;
  harness.v2 = true;
  for (const key of Object.keys(harness.capabilities) as Array<keyof typeof harness.capabilities>) {
    harness.capabilities[key] = true;
  }
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("related screen lifecycle parity", () => {
  it("passes V2 lifecycle actions to root and descendant rows", () => {
    render();
    expect(harness.rows).toHaveLength(2);
    expect(harness.rows[0]).toMatchObject({
      thread: parent,
      variant: "card",
      snoozed: false,
      pinned: false,
      settlementSupported: true,
      snoozeSupported: true,
      pinningSupported: true,
      reorderSupported: true,
      titleRegenerationSupported: true,
      showTrailingDivider: true,
    });
    expect(harness.rows[1]).toMatchObject({
      thread: child,
      variant: "card",
      snoozed: false,
      pinned: false,
      showTrailingDivider: false,
    });
    harness.rows[0]?.onSettleThread(parent);
    expect(harness.actions.settleThread).toHaveBeenCalledWith(parent);
    harness.rows[1]?.onArchiveThread(child);
    expect(harness.actions.archiveThread).toHaveBeenCalledWith(child);
    expect(harness.markRead).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ threadKey: "local:parent" }),
        expect.objectContaining({ threadKey: "local:child" }),
      ]),
    );
  });

  it.each([
    {
      patch: { settledOverride: "settled", settledAt: "2026-09-06T19:00:00.000Z" },
      title: "Un-settle",
      action: "unsettleThread",
    },
    {
      patch: { snoozedUntil: "2026-09-06T21:00:00.000Z" },
      title: "Wake thread",
      action: "unsnoozeThread",
    },
  ] as const)("preserves $title on the root", ({ patch, action }) => {
    const root = { ...parent, ...patch };
    harness.threads = [root, child];
    render();
    expect(harness.rows[0]).toMatchObject({
      thread: root,
      snoozed: action === "unsnoozeThread",
    });
    const rowAction =
      action === "unsettleThread"
        ? harness.rows[0]?.onUnsettleThread
        : harness.rows[0]?.onUnsnoozeThread;
    rowAction?.(root);
    expect(harness.actions[action]).toHaveBeenCalledWith(root);
  });

  it("preserves pinned actions including reorder against the full inbox", () => {
    const root = { ...parent, pinnedAt: parent.createdAt, pinOrderKey: "b" };
    const other = {
      ...parent,
      id: ThreadId.make("other"),
      pinnedAt: parent.createdAt,
      pinOrderKey: "a",
    };
    harness.threads = [root, other, child];
    render();
    expect(harness.rows[0]).toMatchObject({
      pinned: true,
      reorderSupported: true,
      canMoveUp: true,
      canMoveDown: false,
    });
    harness.rows[0]?.onMoveThread?.(root, "up");
    expect(harness.actions.moveThread).toHaveBeenCalledWith(root, "up");
    harness.rows[0]?.onUnpinThread(root);
    expect(harness.actions.unpinThread).toHaveBeenCalledWith(root);
  });

  it("treats the first subgroup row as that screen's root", () => {
    harness.threads = [
      parent,
      child,
      { ...child, id: ThreadId.make("leaf"), parentThreadId: child.id },
    ];
    render(child.id);
    expect(harness.rows[0]).toMatchObject({
      thread: child,
      variant: "card",
      settlementSupported: true,
      snoozeSupported: true,
      pinningSupported: true,
    });
    harness.rows[0]?.onSettleThread(child);
    expect(harness.actions.settleThread).toHaveBeenCalledWith(child);
  });

  it("honors older server capabilities and the legacy list preference", () => {
    harness.capabilities.threadSettlement = false;
    harness.capabilities.threadSnooze = false;
    harness.capabilities.threadPinning = false;
    render();
    expect(harness.rows[0]).toMatchObject({
      settlementSupported: false,
      snoozeSupported: false,
      pinningSupported: false,
    });
    harness.v2 = false;
    render();
    expect(harness.legacyRows.map((row) => row.thread.title)).toEqual(["Parent", "Child"]);
    expect(harness.legacyRows[0]).toMatchObject({
      variant: "compact",
      environmentLabel: null,
      isLast: false,
      titleRegenerationSupported: true,
    });
    harness.legacyRows[0]?.onArchiveThread(parent);
    expect(harness.actions.archiveThread).toHaveBeenCalledWith(parent);
  });
});
