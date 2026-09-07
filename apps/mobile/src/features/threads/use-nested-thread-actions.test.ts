import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AsyncResult } from "effect/unstable/reactivity";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { MobileThreadShell } from "./mobile-thread-hierarchy";
import { useNestedThreadActions } from "./use-nested-thread-actions";

const harness = vi.hoisted(() => ({
  parent: null as MobileThreadShell | null,
  preferences: { threadChildReadAt: {} as Record<string, string> },
  actions: null as ReturnType<typeof useNestedThreadActions> | null,
  navigate: vi.fn(),
  save: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
  useRef: <T>(current: T) => ({ current }),
}));
vi.mock("react-native", () => ({ Alert: { alert: harness.alert } }));
vi.mock("@effect/atom-react", () => ({ useAtomSet: () => harness.save }));
vi.mock("../../lib/use-app-navigation", () => ({
  useAppNavigation: () => ({ navigate: harness.navigate }),
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: "preferences-atom",
  updateMobilePreferencesAtom: "update-preferences-atom",
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "parent-atom" ? harness.parent : AsyncResult.success(harness.preferences),
  },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: {
    threadShellAtom: () => "parent-atom",
  },
  threadEnvironment: { decouple: "decouple-command" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const parentId = ThreadId.make("parent");

function makeThread(input: Partial<MobileThreadShell> = {}): MobileThreadShell {
  return {
    environmentId,
    id: ThreadId.make("agent-run:parent:task"),
    projectId,
    title: "Agent",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-06T19:00:00.000Z",
    updatedAt: "2026-09-06T20:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasPendingQueuedTurn: false,
    hasActionableProposedPlan: false,
    parentThreadId: parentId,
    virtualAgentRun: {
      taskId: "task",
      name: "Agent",
      status: "completed",
      startedAt: "2026-09-06T19:00:00.000Z",
      completedAt: "2026-09-06T20:00:00.000Z",
      parentThreadId: parentId,
    },
    ...input,
  };
}

function Harness(props: { readonly thread: MobileThreadShell }) {
  harness.actions = useNestedThreadActions(props.thread);
  return null;
}

beforeEach(() => {
  harness.parent = null;
  harness.preferences = { threadChildReadAt: {} };
  harness.actions = null;
  harness.navigate.mockReset();
  harness.save.mockReset();
  harness.alert.mockReset();
});

describe("nested thread actions", () => {
  it("does not acknowledge a synthetic result when its parent is unavailable", () => {
    renderToStaticMarkup(createElement(Harness, { thread: makeThread() }));

    harness.actions?.openParent();

    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.alert).toHaveBeenCalledWith(
      "Parent chat unavailable",
      "The parent chat was archived or deleted. Archived chats can be restored from Settings.",
    );
  });

  it("acknowledges the synthetic result only after opening an active parent", () => {
    harness.parent = {
      ...makeThread(),
      id: parentId,
      title: "Parent",
      parentThreadId: undefined,
      virtualAgentRun: undefined,
    };
    renderToStaticMarkup(createElement(Harness, { thread: makeThread() }));

    harness.actions?.openParent();

    expect(harness.save).toHaveBeenCalledWith({
      threadChildReadAt: {
        [`${environmentId}:agent-run:${parentId}:task`]: "2026-09-06T20:00:00.000Z",
      },
    });
    expect(harness.navigate).toHaveBeenCalledWith("Thread", {
      environmentId,
      threadId: parentId,
    });
  });
});
