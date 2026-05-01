import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  type ChatSplitLayout,
  type ChatSplitNodeId,
  clampSplitRatio,
  closeLeaf,
  countLeafNodes,
  createInitialChatSplitLayout,
  findLeafNodeByTarget,
  findNeighborLeafId,
  focusLeaf,
  focusNeighbor,
  getFocusedLeaf,
  getLeafIds,
  getLeafTargetsInRenderOrder,
  isLeafNode,
  isSplitNode,
  replaceLeafTarget,
  setSplitRatio,
  splitLeaf,
  splitLeafWithTarget,
  syncLayoutWithRouteTarget,
  toggleLeafMaximized,
} from "./chatSplitLayout";
import { DraftId } from "./composerDraftStore";
import type { ThreadRouteTarget } from "./threadRoutes";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

function serverTarget(env: EnvironmentId, thread: string): ThreadRouteTarget {
  return {
    kind: "server",
    threadRef: { environmentId: env, threadId: ThreadId.make(thread) },
  };
}

function draftTarget(id: string): ThreadRouteTarget {
  return { kind: "draft", draftId: DraftId.make(id) };
}

function makeIdFactory(prefix = "n"): () => ChatSplitNodeId {
  let i = 0;
  return () => `${prefix}-${++i}`;
}

function initial(): ChatSplitLayout {
  return createInitialChatSplitLayout({
    leafId: "root",
    target: serverTarget(envA, "t-1"),
  });
}

describe("chatSplitLayout — splitting", () => {
  it("splits a leaf horizontally and focuses the new leaf", () => {
    const id = makeIdFactory();
    const next = splitLeaf(initial(), "root", "row", id);
    expect(countLeafNodes(next)).toBe(2);
    const root = next.nodesById[next.rootId]!;
    expect(isSplitNode(root)).toBe(true);
    if (root.kind !== "split") throw new Error("expected split");
    expect(root.orientation).toBe("row");
    expect(root.first).toBe("root");
    expect(root.second).toBe(next.focusedLeafId);
    const focused = getFocusedLeaf(next);
    expect(focused?.target).toBeNull();
  });

  it("supports nested splits to arbitrary depth", () => {
    const id = makeIdFactory();
    let layout = initial();
    layout = splitLeaf(layout, layout.focusedLeafId, "row", id);
    layout = splitLeaf(layout, layout.focusedLeafId, "column", id);
    layout = splitLeaf(layout, layout.focusedLeafId, "row", id);
    expect(countLeafNodes(layout)).toBe(4);
    // Tree must remain a connected DAG rooted at rootId with no orphans.
    const reachable = new Set<string>();
    const walk = (nid: string) => {
      reachable.add(nid);
      const n = layout.nodesById[nid]!;
      if (n.kind === "split") {
        walk(n.first);
        walk(n.second);
      }
    };
    walk(layout.rootId);
    expect(reachable.size).toBe(Object.keys(layout.nodesById).length);
  });

  it("returns leaf targets in visual render order", () => {
    const id = makeIdFactory();
    let layout = initial();
    layout = splitLeaf(layout, "root", "row", id);
    const rightLeafId = layout.focusedLeafId;
    layout = replaceLeafTarget(layout, rightLeafId, serverTarget(envA, "t-2"));
    layout = splitLeaf(layout, rightLeafId, "column", id);
    layout = replaceLeafTarget(layout, layout.focusedLeafId, serverTarget(envA, "t-3"));

    expect(getLeafTargetsInRenderOrder(layout).map((leaf) => leaf.target)).toEqual([
      serverTarget(envA, "t-1"),
      serverTarget(envA, "t-2"),
      serverTarget(envA, "t-3"),
    ]);
  });

  it.each([
    ["left", ["t-2", "t-1"]],
    ["right", ["t-1", "t-2"]],
    ["top", ["t-2", "t-1"]],
    ["bottom", ["t-1", "t-2"]],
  ] as const)("splits a leaf with a dropped target on the %s", (placement, expectedThreads) => {
    const layout = splitLeafWithTarget(
      initial(),
      "root",
      serverTarget(envA, "t-2"),
      placement,
      makeIdFactory(),
    );

    expect(countLeafNodes(layout)).toBe(2);
    expect(getLeafTargetsInRenderOrder(layout).map((leaf) => leaf.target)).toEqual(
      expectedThreads.map((thread) => serverTarget(envA, thread)),
    );
    expect(getFocusedLeaf(layout)?.target).toEqual(serverTarget(envA, "t-2"));
  });
});

describe("chatSplitLayout — closing & promotion", () => {
  it("closing a leaf promotes its sibling and removes orphan split node", () => {
    const id = makeIdFactory();
    let layout = initial();
    layout = splitLeaf(layout, "root", "row", id); // root split with first=root, second=n-2
    const newLeafId = layout.focusedLeafId;
    const splitId = layout.rootId;
    layout = closeLeaf(layout, newLeafId);
    expect(countLeafNodes(layout)).toBe(1);
    expect(layout.rootId).toBe("root");
    expect(layout.nodesById[newLeafId]).toBeUndefined();
    expect(layout.nodesById[splitId]).toBeUndefined();
    expect(layout.focusedLeafId).toBe("root");
  });

  it("closing focused leaf moves focus to a neighboring leaf", () => {
    const id = makeIdFactory();
    let layout = initial();
    layout = splitLeaf(layout, "root", "row", id);
    const focused = layout.focusedLeafId;
    layout = closeLeaf(layout, focused);
    expect(layout.focusedLeafId).toBe("root");
  });

  it("closing a leaf in a deep tree promotes its sibling subtree intact", () => {
    const id = makeIdFactory();
    let layout = initial();
    layout = splitLeaf(layout, "root", "row", id); // [root | A]
    const a = layout.focusedLeafId;
    layout = splitLeaf(layout, a, "column", id); // right side becomes [A / B]
    const beforeLeaves = getLeafIds(layout);
    layout = closeLeaf(layout, "root");
    expect(countLeafNodes(layout)).toBe(2);
    // The remaining tree must be exactly the sibling subtree of root.
    expect(getLeafIds(layout)).toEqual(beforeLeaves.filter((l) => l !== "root").toSorted());
  });
});

describe("chatSplitLayout — focus & neighbors", () => {
  it("focusNeighbor moves right within a row split", () => {
    const id = makeIdFactory();
    let layout = initial();
    layout = splitLeaf(layout, "root", "row", id);
    const right = layout.focusedLeafId;
    layout = focusLeaf(layout, "root");
    expect(findNeighborLeafId(layout, "root", "right")).toBe(right);
    layout = focusNeighbor(layout, "right");
    expect(layout.focusedLeafId).toBe(right);
  });

  it("focusNeighbor returns same layout when there is no neighbor", () => {
    const layout = initial();
    const next = focusNeighbor(layout, "right");
    expect(next).toBe(layout);
  });

  it("focusNeighbor traverses across nested splits to find the closest leaf", () => {
    const id = makeIdFactory();
    let layout = initial();
    layout = splitLeaf(layout, "root", "row", id); // root | n-2
    const right = layout.focusedLeafId;
    layout = splitLeaf(layout, right, "column", id); // right side becomes n-2 / n-4
    layout = focusLeaf(layout, "root");
    layout = focusNeighbor(layout, "right");
    // Should land on the upper-left leaf of the right subtree (the sibling closest to "root").
    expect(layout.focusedLeafId).toBe(right);
  });
});

describe("chatSplitLayout — ratios", () => {
  it("clamps ratios to the configured min/max", () => {
    expect(clampSplitRatio(0)).toBeCloseTo(0.15);
    expect(clampSplitRatio(1)).toBeCloseTo(0.85);
    expect(clampSplitRatio(0.5)).toBeCloseTo(0.5);
    expect(clampSplitRatio(Number.NaN)).toBeCloseTo(0.5);
  });

  it("setSplitRatio updates only the targeted split node", () => {
    const id = makeIdFactory();
    let layout = initial();
    layout = splitLeaf(layout, "root", "row", id);
    const splitId = layout.rootId;
    const before = layout.nodesById[splitId]!;
    const next = setSplitRatio(layout, splitId, 0.7);
    expect((next.nodesById[splitId] as { ratio: number }).ratio).toBeCloseTo(0.7);
    // Other nodes are referentially equal — leaves must not re-render.
    expect(next.nodesById["root"]).toBe(layout.nodesById["root"]);
    expect(next).not.toBe(layout);
    expect(before).not.toBe(next.nodesById[splitId]);
  });
});

describe("chatSplitLayout — maximize", () => {
  it("toggles maximize on and off for the same leaf", () => {
    const id = makeIdFactory();
    let layout = initial();
    layout = splitLeaf(layout, "root", "row", id);
    const focused = layout.focusedLeafId;
    layout = toggleLeafMaximized(layout, focused);
    expect(layout.maximizedLeafId).toBe(focused);
    layout = toggleLeafMaximized(layout, focused);
    expect(layout.maximizedLeafId).toBeNull();
  });

  it("closing the maximized leaf clears the maximized flag", () => {
    const id = makeIdFactory();
    let layout = initial();
    layout = splitLeaf(layout, "root", "row", id);
    const focused = layout.focusedLeafId;
    layout = toggleLeafMaximized(layout, focused);
    layout = closeLeaf(layout, focused);
    expect(layout.maximizedLeafId).toBeNull();
  });
});

describe("chatSplitLayout — syncLayoutWithRouteTarget", () => {
  it("focuses an existing matching leaf instead of replacing the focused one", () => {
    const id = makeIdFactory();
    let layout = initial();
    layout = splitLeaf(layout, "root", "row", id); // focus on new leaf, target = t-1
    // Replace the new leaf's target so the two leaves differ.
    const focusedId = layout.focusedLeafId;
    const targetB = serverTarget(envA, "t-2");
    layout = syncLayoutWithRouteTarget(layout, targetB);
    expect(findLeafNodeByTarget(layout, targetB)?.id).toBe(focusedId);

    // Now focus the original leaf, then sync with t-2 again — must focus, not replace.
    layout = focusLeaf(layout, "root");
    const before = layout;
    const next = syncLayoutWithRouteTarget(layout, targetB);
    expect(next.focusedLeafId).toBe(focusedId);
    // root leaf still holds t-1
    const rootLeaf = next.nodesById["root"]!;
    if (!isLeafNode(rootLeaf)) throw new Error("expected leaf");
    expect(rootLeaf.target).toEqual(serverTarget(envA, "t-1"));
    expect(next).not.toBe(before);
  });

  it("does not clobber leaf diff state when diff is omitted", () => {
    let layout = initial();
    layout = syncLayoutWithRouteTarget(layout, serverTarget(envA, "t-1"), {
      diff: "1",
    });
    const before = (layout.nodesById["root"] as { diff: { diff?: string } }).diff;
    expect(before.diff).toBe("1");
    layout = syncLayoutWithRouteTarget(layout, serverTarget(envA, "t-1"));
    const after = (layout.nodesById["root"] as { diff: { diff?: string } }).diff;
    expect(after.diff).toBe("1");
  });

  it("idempotent re-sync with the same target returns the same layout reference", () => {
    const layout = initial();
    const next = syncLayoutWithRouteTarget(layout, serverTarget(envA, "t-1"));
    expect(next).toBe(layout);
  });

  it("replaces the focused leaf's target when no matching leaf exists", () => {
    const layout = initial();
    const next = syncLayoutWithRouteTarget(layout, draftTarget("d-1"));
    const focused = getFocusedLeaf(next)!;
    expect(focused.target).toEqual(draftTarget("d-1"));
  });

  it("fills an empty split leaf before replacing a focused chat leaf", () => {
    const id = makeIdFactory();
    let layout = splitLeaf(initial(), "root", "row", id);
    const emptyLeafId = layout.focusedLeafId;
    layout = focusLeaf(layout, "root");

    const next = syncLayoutWithRouteTarget(layout, serverTarget(envA, "t-2"));

    expect(next.focusedLeafId).toBe(emptyLeafId);
    expect(findLeafNodeByTarget(next, serverTarget(envA, "t-1"))).not.toBeNull();
    expect(findLeafNodeByTarget(next, serverTarget(envA, "t-2"))?.id).toBe(emptyLeafId);
  });

  it("moves the maximized pane when routing to an existing hidden split leaf", () => {
    const id = makeIdFactory();
    let layout = splitLeaf(initial(), "root", "row", id);
    const rightLeafId = layout.focusedLeafId;
    const targetB = serverTarget(envA, "t-2");
    layout = replaceLeafTarget(layout, rightLeafId, targetB);
    layout = focusLeaf(layout, "root");
    layout = toggleLeafMaximized(layout, "root");

    const next = syncLayoutWithRouteTarget(layout, targetB);

    expect(next.focusedLeafId).toBe(rightLeafId);
    expect(next.maximizedLeafId).toBe(rightLeafId);
  });

  it("replaces the visible maximized pane when routing to a new target", () => {
    const id = makeIdFactory();
    let layout = splitLeaf(initial(), "root", "row", id);
    const rightLeafId = layout.focusedLeafId;
    layout = replaceLeafTarget(layout, rightLeafId, serverTarget(envA, "t-2"));
    layout = focusLeaf(layout, "root");
    layout = toggleLeafMaximized(layout, "root");

    const next = syncLayoutWithRouteTarget(layout, serverTarget(envA, "t-3"));

    expect(next.focusedLeafId).toBe("root");
    expect(next.maximizedLeafId).toBe("root");
    expect(findLeafNodeByTarget(next, serverTarget(envA, "t-3"))?.id).toBe("root");
    expect(findLeafNodeByTarget(next, serverTarget(envA, "t-2"))?.id).toBe(rightLeafId);
  });

  it("works across two environments", () => {
    const id = makeIdFactory();
    let layout = initial();
    layout = splitLeaf(layout, "root", "row", id);
    layout = syncLayoutWithRouteTarget(layout, serverTarget(envB, "t-9"));
    expect(findLeafNodeByTarget(layout, serverTarget(envB, "t-9"))).not.toBeNull();
    expect(findLeafNodeByTarget(layout, serverTarget(envA, "t-1"))).not.toBeNull();
  });
});
