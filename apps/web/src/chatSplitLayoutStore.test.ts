import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  countLeafNodes,
  findLeafNodeByTarget,
  getFocusedLeaf,
  getLeafTargetsInRenderOrder,
} from "./chatSplitLayout";
import { deriveChatSplitLayoutId, useChatSplitLayoutStore } from "./chatSplitLayoutStore";

const initialState = useChatSplitLayoutStore.getState();

afterEach(() => {
  useChatSplitLayoutStore.setState(initialState, true);
});

describe("chatSplitLayoutStore", () => {
  it("derives distinct layout ids for different environments", () => {
    expect(
      deriveChatSplitLayoutId({
        kind: "server",
        threadRef: {
          environmentId: EnvironmentId.make("env-a"),
          threadId: ThreadId.make("thread-1"),
        },
      }),
    ).toBe("environment:env-a");

    expect(
      deriveChatSplitLayoutId({
        kind: "server",
        threadRef: {
          environmentId: EnvironmentId.make("env-b"),
          threadId: ThreadId.make("thread-1"),
        },
      }),
    ).toBe("environment:env-b");
  });

  it("keeps layouts scoped per environment when route targets change", () => {
    const envA = EnvironmentId.make("env-a");
    const envB = EnvironmentId.make("env-b");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envB,
        threadId: ThreadId.make("thread-b"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    let state = useChatSplitLayoutStore.getState();
    const layoutA = state.layoutsById[deriveChatSplitLayoutId(targetA)];
    expect(state.activeLayoutId).toBe(deriveChatSplitLayoutId(targetA));
    expect(layoutA).toBeDefined();
    expect(countLeafNodes(layoutA!)).toBe(2);

    useChatSplitLayoutStore.getState().syncRouteTarget(targetB);
    state = useChatSplitLayoutStore.getState();
    const layoutB = state.layoutsById[deriveChatSplitLayoutId(targetB)];
    expect(state.activeLayoutId).toBe(deriveChatSplitLayoutId(targetB));
    expect(layoutB).toBeDefined();
    expect(countLeafNodes(layoutB!)).toBe(1);

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    state = useChatSplitLayoutStore.getState();
    expect(state.activeLayoutId).toBe(deriveChatSplitLayoutId(targetA));
    expect(countLeafNodes(state.layoutsById[deriveChatSplitLayoutId(targetA)]!)).toBe(2);
  });

  it("keeps the current split workspace during normal route selection", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };
    const targetC = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-c"),
      },
    };
    const targetD = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-d"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    let state = useChatSplitLayoutStore.getState();
    const firstLayoutId = state.activeLayoutId;
    const firstLayout = state.layoutsById[firstLayoutId]!;
    useChatSplitLayoutStore.getState().replaceLeafTarget(firstLayout.focusedLeafId, targetB);

    const focusedTarget = useChatSplitLayoutStore
      .getState()
      .openWorkspaceFromTargets([targetC, targetD], "column");
    expect(focusedTarget).toEqual(targetD);

    state = useChatSplitLayoutStore.getState();
    expect(Object.keys(state.layoutsById)).toHaveLength(2);
    expect(state.activeLayoutId).not.toBe(firstLayoutId);
    expect(findLeafNodeByTarget(state.layoutsById[firstLayoutId]!, targetA)).not.toBeNull();
    expect(findLeafNodeByTarget(state.layoutsById[firstLayoutId]!, targetB)).not.toBeNull();
    expect(findLeafNodeByTarget(state.layoutsById[state.activeLayoutId]!, targetC)).not.toBeNull();
    expect(findLeafNodeByTarget(state.layoutsById[state.activeLayoutId]!, targetD)).not.toBeNull();

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    state = useChatSplitLayoutStore.getState();
    expect(state.activeLayoutId).not.toBe(firstLayoutId);
    expect(countLeafNodes(state.layoutsById[state.activeLayoutId]!)).toBe(2);
    expect(findLeafNodeByTarget(state.layoutsById[state.activeLayoutId]!, targetA)).not.toBeNull();
    expect(findLeafNodeByTarget(state.layoutsById[state.activeLayoutId]!, targetC)).not.toBeNull();
    expect(findLeafNodeByTarget(state.layoutsById[state.activeLayoutId]!, targetD)).toBeNull();
    expect(countLeafNodes(state.layoutsById[firstLayoutId]!)).toBe(2);
  });

  it("replaces the active split workspace when selected targets overlap it", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };
    const targetC = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-c"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    let state = useChatSplitLayoutStore.getState();
    const activeLayoutId = state.activeLayoutId;
    const activeLayout = state.layoutsById[activeLayoutId]!;
    useChatSplitLayoutStore.getState().replaceLeafTarget(activeLayout.focusedLeafId, targetB);

    useChatSplitLayoutStore.getState().openWorkspaceFromTargets([targetB, targetC], "row");

    state = useChatSplitLayoutStore.getState();
    expect(Object.keys(state.layoutsById)).toHaveLength(1);
    expect(state.activeLayoutId).toBe(activeLayoutId);
    expect(findLeafNodeByTarget(state.layoutsById[activeLayoutId]!, targetA)).toBeNull();
    expect(findLeafNodeByTarget(state.layoutsById[activeLayoutId]!, targetB)).not.toBeNull();
    expect(findLeafNodeByTarget(state.layoutsById[activeLayoutId]!, targetC)).not.toBeNull();
  });

  it("keeps the active split when routing to a thread outside the current split", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };
    const targetC = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-c"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    let state = useChatSplitLayoutStore.getState();
    const activeLayout = state.layoutsById[state.activeLayoutId]!;
    useChatSplitLayoutStore.getState().replaceLeafTarget(activeLayout.focusedLeafId, targetB);

    state = useChatSplitLayoutStore.getState();
    const activeLayoutId = state.activeLayoutId;

    useChatSplitLayoutStore.getState().syncRouteTarget(targetC);

    state = useChatSplitLayoutStore.getState();
    expect(state.activeLayoutId).toBe(activeLayoutId);
    expect(countLeafNodes(state.layoutsById[state.activeLayoutId]!)).toBe(2);
    expect(findLeafNodeByTarget(state.layoutsById[state.activeLayoutId]!, targetB)).toBeNull();
    expect(findLeafNodeByTarget(state.layoutsById[state.activeLayoutId]!, targetC)).not.toBeNull();
  });

  it("maximizes and restores the focused pane without discarding the split", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    let state = useChatSplitLayoutStore.getState();
    const activeLayout = state.layoutsById[state.activeLayoutId]!;
    const targetBLeafId = activeLayout.focusedLeafId;
    useChatSplitLayoutStore.getState().replaceLeafTarget(targetBLeafId, targetB);

    useChatSplitLayoutStore.getState().focusLeaf(targetBLeafId);
    useChatSplitLayoutStore.getState().toggleFocusedLeafMaximized();

    state = useChatSplitLayoutStore.getState();
    let layout = state.layoutsById[state.activeLayoutId]!;
    expect(countLeafNodes(layout)).toBe(2);
    expect(layout.maximizedLeafId).toBe(targetBLeafId);
    expect(findLeafNodeByTarget(layout, targetA)).not.toBeNull();
    expect(findLeafNodeByTarget(layout, targetB)).not.toBeNull();

    useChatSplitLayoutStore.getState().toggleFocusedLeafMaximized();

    state = useChatSplitLayoutStore.getState();
    layout = state.layoutsById[state.activeLayoutId]!;
    expect(countLeafNodes(layout)).toBe(2);
    expect(layout.maximizedLeafId).toBeNull();
    expect(findLeafNodeByTarget(layout, targetA)).not.toBeNull();
    expect(findLeafNodeByTarget(layout, targetB)).not.toBeNull();
  });

  it("drops a thread target into a specific leaf placement", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    let state = useChatSplitLayoutStore.getState();
    const leafId = state.layoutsById[state.activeLayoutId]!.focusedLeafId;

    expect(useChatSplitLayoutStore.getState().dropTargetIntoLeaf(leafId, targetB, "left")).toEqual(
      targetB,
    );

    state = useChatSplitLayoutStore.getState();
    const layout = state.layoutsById[state.activeLayoutId]!;
    expect(getLeafTargetsInRenderOrder(layout).map((leaf) => leaf.target)).toEqual([
      targetB,
      targetA,
    ]);
    expect(getFocusedLeaf(layout)?.target).toEqual(targetB);
  });

  it("fills a blank split leaf when a thread is dropped onto it", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    let state = useChatSplitLayoutStore.getState();
    const layout = state.layoutsById[state.activeLayoutId]!;
    const blankLeafId = layout.focusedLeafId;
    expect(getFocusedLeaf(layout)?.target).toBeNull();

    expect(
      useChatSplitLayoutStore.getState().dropTargetIntoLeaf(blankLeafId, targetB, "right"),
    ).toEqual(targetB);

    state = useChatSplitLayoutStore.getState();
    const nextLayout = state.layoutsById[state.activeLayoutId]!;
    expect(countLeafNodes(nextLayout)).toBe(2);
    expect(getLeafTargetsInRenderOrder(nextLayout).map((leaf) => leaf.target)).toEqual([
      targetA,
      targetB,
    ]);
  });

  it("fills a blank split leaf on route selection even when another pane is focused", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    let state = useChatSplitLayoutStore.getState();
    const blankLeafId = state.layoutsById[state.activeLayoutId]!.focusedLeafId;
    const targetALeafId = findLeafNodeByTarget(
      state.layoutsById[state.activeLayoutId]!,
      targetA,
    )!.id;
    useChatSplitLayoutStore.getState().focusLeaf(targetALeafId);

    useChatSplitLayoutStore.getState().syncRouteTarget(targetB);

    state = useChatSplitLayoutStore.getState();
    const layout = state.layoutsById[state.activeLayoutId]!;
    expect(layout.focusedLeafId).toBe(blankLeafId);
    expect(findLeafNodeByTarget(layout, targetA)).not.toBeNull();
    expect(findLeafNodeByTarget(layout, targetB)?.id).toBe(blankLeafId);
  });

  it("focuses an existing split leaf instead of duplicating a dropped thread", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    let state = useChatSplitLayoutStore.getState();
    const leafId = state.layoutsById[state.activeLayoutId]!.focusedLeafId;
    useChatSplitLayoutStore.getState().dropTargetIntoLeaf(leafId, targetB, "right");

    state = useChatSplitLayoutStore.getState();
    const layout = state.layoutsById[state.activeLayoutId]!;
    const targetALeafId = findLeafNodeByTarget(layout, targetA)!.id;
    useChatSplitLayoutStore.getState().dropTargetIntoLeaf(targetALeafId, targetB, "bottom");

    state = useChatSplitLayoutStore.getState();
    expect(countLeafNodes(state.layoutsById[state.activeLayoutId]!)).toBe(2);
    expect(getFocusedLeaf(state.layoutsById[state.activeLayoutId]!)?.target).toEqual(targetB);
  });
});
