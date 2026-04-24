import { Debouncer } from "@tanstack/react-pacer";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

import type { DiffRouteSearch } from "./diffRouteSearch";
import {
  type ChatSplitFocusDirection,
  type ChatSplitLayout,
  type ChatSplitNode,
  type ChatSplitNodeId,
  closeLeaf,
  countLeafNodes,
  createInitialChatSplitLayout,
  diffRouteStatesEqual,
  findLeafNodeByTarget,
  focusLeaf as focusLeafInLayout,
  focusNeighbor as focusNeighborInLayout,
  getFocusedLeaf,
  getFocusedLeafTarget,
  getLeafNode,
  replaceLeafTarget as replaceLeafTargetInLayout,
  sanitizeDiffRouteState,
  setLeafDiff,
  setSplitRatio as setSplitRatioInLayout,
  splitLeaf,
  syncLayoutWithRouteTarget,
  toggleLeafMaximized,
} from "./chatSplitLayout";
import type { ThreadRouteTarget } from "./threadRoutes";
import type { DraftId } from "./composerDraftStore";

export const CHAT_SPLIT_LAYOUT_STORAGE_KEY = "t3code:chat-split-layout:v1";
export const DEFAULT_CHAT_SPLIT_LAYOUT_ID = "default";

interface PersistedChatSplitLayoutDocument {
  activeLayoutId?: string;
  layoutsById?: Record<string, unknown>;
}

interface ChatSplitLayoutStoreState {
  activeLayoutId: string;
  layoutsById: Record<string, ChatSplitLayout>;
  syncRouteTarget: (target: ThreadRouteTarget, diff?: DiffRouteSearch) => void;
  focusLeaf: (leafId: ChatSplitNodeId) => ThreadRouteTarget | null;
  focusNeighbor: (direction: ChatSplitFocusDirection) => ThreadRouteTarget | null;
  replaceLeafTarget: (
    leafId: ChatSplitNodeId,
    target: ThreadRouteTarget,
    diff?: DiffRouteSearch,
  ) => void;
  setFocusedLeafDiff: (diff: DiffRouteSearch) => void;
  splitFocusedLeaf: (orientation: "row" | "column") => void;
  closeFocusedLeaf: () => ThreadRouteTarget | null;
  toggleFocusedLeafMaximized: () => void;
  setSplitRatio: (splitId: ChatSplitNodeId, ratio: number) => void;
}

function createNodeId(): ChatSplitNodeId {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `pane-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizePersistedTarget(value: unknown): ThreadRouteTarget | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }

  if (value.kind === "server") {
    const threadRef = value.threadRef;
    if (
      !isRecord(threadRef) ||
      typeof threadRef.environmentId !== "string" ||
      threadRef.environmentId.length === 0 ||
      typeof threadRef.threadId !== "string" ||
      threadRef.threadId.length === 0
    ) {
      return null;
    }
    return {
      kind: "server",
      threadRef: {
        environmentId: threadRef.environmentId as EnvironmentId,
        threadId: threadRef.threadId as ThreadId,
      },
    };
  }

  if (value.kind !== "draft" || typeof value.draftId !== "string" || value.draftId.length === 0) {
    return null;
  }
  return {
    kind: "draft",
    draftId: value.draftId as DraftId,
  };
}

function sanitizePersistedNode(nodeId: string, value: unknown): ChatSplitNode | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }

  if (value.kind === "leaf") {
    const target = sanitizePersistedTarget(value.target);
    if (!target) {
      return null;
    }
    return {
      kind: "leaf",
      id: nodeId,
      target,
      diff: sanitizeDiffRouteState(isRecord(value.diff) ? (value.diff as DiffRouteSearch) : {}),
    };
  }

  if (
    value.kind !== "split" ||
    (value.orientation !== "row" && value.orientation !== "column") ||
    typeof value.first !== "string" ||
    value.first.length === 0 ||
    typeof value.second !== "string" ||
    value.second.length === 0
  ) {
    return null;
  }

  return {
    kind: "split",
    id: nodeId,
    orientation: value.orientation,
    ratio: typeof value.ratio === "number" ? value.ratio : 0.5,
    first: value.first,
    second: value.second,
  };
}

function collectReachableNodeIds(
  rootId: ChatSplitNodeId,
  nodesById: Record<ChatSplitNodeId, ChatSplitNode>,
): Set<ChatSplitNodeId> | null {
  const reachable = new Set<ChatSplitNodeId>();
  const visiting = new Set<ChatSplitNodeId>();

  const visit = (nodeId: ChatSplitNodeId): boolean => {
    if (reachable.has(nodeId)) {
      return true;
    }
    if (visiting.has(nodeId)) {
      return false;
    }

    const node = nodesById[nodeId];
    if (!node) {
      return false;
    }
    visiting.add(nodeId);
    if (node.kind === "split") {
      if (!visit(node.first) || !visit(node.second)) {
        return false;
      }
    }
    visiting.delete(nodeId);
    reachable.add(nodeId);
    return true;
  };

  return visit(rootId) ? reachable : null;
}

function sanitizePersistedLayout(value: unknown): ChatSplitLayout | null {
  if (
    !isRecord(value) ||
    typeof value.rootId !== "string" ||
    typeof value.focusedLeafId !== "string"
  ) {
    return null;
  }

  const rawNodes = value.nodesById;
  if (!isRecord(rawNodes)) {
    return null;
  }

  const nodesById = Object.fromEntries(
    Object.entries(rawNodes).flatMap(([nodeId, rawNode]) => {
      const nextNode = sanitizePersistedNode(nodeId, rawNode);
      return nextNode ? [[nodeId, nextNode] as const] : [];
    }),
  );
  const reachableIds = collectReachableNodeIds(value.rootId, nodesById);
  if (!reachableIds) {
    return null;
  }

  const reachableNodesById = Object.fromEntries(
    [...reachableIds].flatMap((nodeId) => {
      const node = nodesById[nodeId];
      return node ? [[nodeId, node] as const] : [];
    }),
  );
  const reachableLeafIds = Object.values(reachableNodesById)
    .flatMap((node) => (node.kind === "leaf" ? [node.id] : []))
    .toSorted();
  if (reachableLeafIds.length === 0) {
    return null;
  }

  const focusedLeafId = reachableLeafIds.includes(value.focusedLeafId)
    ? value.focusedLeafId
    : reachableLeafIds[0]!;
  const maximizedLeafId =
    typeof value.maximizedLeafId === "string" && reachableLeafIds.includes(value.maximizedLeafId)
      ? value.maximizedLeafId
      : null;

  return {
    rootId: value.rootId,
    nodesById: reachableNodesById,
    focusedLeafId,
    maximizedLeafId,
  };
}

export function readPersistedChatSplitLayoutState(): Pick<
  ChatSplitLayoutStoreState,
  "activeLayoutId" | "layoutsById"
> {
  if (typeof window === "undefined") {
    return {
      activeLayoutId: DEFAULT_CHAT_SPLIT_LAYOUT_ID,
      layoutsById: {},
    };
  }

  try {
    const raw = window.localStorage.getItem(CHAT_SPLIT_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return {
        activeLayoutId: DEFAULT_CHAT_SPLIT_LAYOUT_ID,
        layoutsById: {},
      };
    }

    const parsed = JSON.parse(raw) as PersistedChatSplitLayoutDocument;
    const layoutsById = Object.fromEntries(
      Object.entries(parsed.layoutsById ?? {}).flatMap(([layoutId, rawLayout]) => {
        const nextLayout = sanitizePersistedLayout(rawLayout);
        return nextLayout ? [[layoutId, nextLayout] as const] : [];
      }),
    );
    const activeLayoutId =
      typeof parsed.activeLayoutId === "string" && parsed.activeLayoutId in layoutsById
        ? parsed.activeLayoutId
        : (Object.keys(layoutsById)[0] ?? DEFAULT_CHAT_SPLIT_LAYOUT_ID);

    return {
      activeLayoutId,
      layoutsById,
    };
  } catch {
    return {
      activeLayoutId: DEFAULT_CHAT_SPLIT_LAYOUT_ID,
      layoutsById: {},
    };
  }
}

export function persistChatSplitLayoutState(
  state: Pick<ChatSplitLayoutStoreState, "activeLayoutId" | "layoutsById">,
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      CHAT_SPLIT_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        activeLayoutId: state.activeLayoutId,
        layoutsById: state.layoutsById,
      } satisfies PersistedChatSplitLayoutDocument),
    );
  } catch {
    // Ignore storage failures so layout persistence never breaks the workspace.
  }
}

const debouncedPersistState = new Debouncer(persistChatSplitLayoutState, {
  wait: 300,
});

function updateActiveLayout(
  state: ChatSplitLayoutStoreState,
  updater: (layout: ChatSplitLayout) => ChatSplitLayout,
): ChatSplitLayoutStoreState {
  const activeLayout = state.layoutsById[state.activeLayoutId];
  if (!activeLayout) {
    return state;
  }
  const nextLayout = updater(activeLayout);
  if (nextLayout === activeLayout) {
    return state;
  }
  return {
    ...state,
    layoutsById: {
      ...state.layoutsById,
      [state.activeLayoutId]: nextLayout,
    },
  };
}

export function selectActiveChatSplitLayout(
  state: Pick<ChatSplitLayoutStoreState, "activeLayoutId" | "layoutsById">,
): ChatSplitLayout | null {
  return state.layoutsById[state.activeLayoutId] ?? null;
}

export function selectChatSplitNode(
  state: Pick<ChatSplitLayoutStoreState, "activeLayoutId" | "layoutsById">,
  nodeId: ChatSplitNodeId,
): ChatSplitNode | null {
  return selectActiveChatSplitLayout(state)?.nodesById[nodeId] ?? null;
}

export function selectChatSplitFocusedLeaf(
  state: Pick<ChatSplitLayoutStoreState, "activeLayoutId" | "layoutsById">,
) {
  const activeLayout = selectActiveChatSplitLayout(state);
  return activeLayout ? getFocusedLeaf(activeLayout) : null;
}

export const useChatSplitLayoutStore = create<ChatSplitLayoutStoreState>((set, get) => ({
  ...readPersistedChatSplitLayoutState(),
  syncRouteTarget: (target, diff) => {
    set((state) => {
      const activeLayout = selectActiveChatSplitLayout(state);
      if (!activeLayout) {
        const initialLeafId = createNodeId();
        return {
          ...state,
          layoutsById: {
            ...state.layoutsById,
            [state.activeLayoutId]: createInitialChatSplitLayout({
              leafId: initialLeafId,
              target,
              ...(diff !== undefined ? { diff } : {}),
            }),
          },
        };
      }

      return updateActiveLayout(state, (layout) => syncLayoutWithRouteTarget(layout, target, diff));
    });
  },
  focusLeaf: (leafId) => {
    const activeLayout = selectActiveChatSplitLayout(get());
    const nextTarget = activeLayout ? (getLeafNode(activeLayout, leafId)?.target ?? null) : null;
    if (!nextTarget) {
      return null;
    }
    set((state) => updateActiveLayout(state, (layout) => focusLeafInLayout(layout, leafId)));
    return nextTarget;
  },
  focusNeighbor: (direction) => {
    const activeLayout = selectActiveChatSplitLayout(get());
    if (!activeLayout) {
      return null;
    }

    const nextLayout = focusNeighborInLayout(activeLayout, direction);
    const nextTarget = nextLayout === activeLayout ? null : getFocusedLeafTarget(nextLayout);
    if (!nextTarget) {
      return null;
    }
    set((state) => updateActiveLayout(state, () => nextLayout));
    return nextTarget;
  },
  replaceLeafTarget: (leafId, target, diff) => {
    set((state) =>
      updateActiveLayout(state, (layout) =>
        replaceLeafTargetInLayout(layout, leafId, target, diff),
      ),
    );
  },
  setFocusedLeafDiff: (diff) => {
    set((state) =>
      updateActiveLayout(state, (layout) => setLeafDiff(layout, layout.focusedLeafId, diff)),
    );
  },
  splitFocusedLeaf: (orientation) => {
    set((state) =>
      updateActiveLayout(state, (layout) =>
        splitLeaf(layout, layout.focusedLeafId, orientation, createNodeId),
      ),
    );
  },
  closeFocusedLeaf: () => {
    const activeLayout = selectActiveChatSplitLayout(get());
    if (!activeLayout || countLeafNodes(activeLayout) <= 1) {
      return null;
    }

    const nextLayout = closeLeaf(activeLayout, activeLayout.focusedLeafId);
    const nextTarget = getFocusedLeafTarget(nextLayout);
    if (!nextTarget) {
      return null;
    }
    set((state) => updateActiveLayout(state, () => nextLayout));
    return nextTarget;
  },
  toggleFocusedLeafMaximized: () => {
    set((state) =>
      updateActiveLayout(state, (layout) => toggleLeafMaximized(layout, layout.focusedLeafId)),
    );
  },
  setSplitRatio: (splitId, ratio) => {
    set((state) =>
      updateActiveLayout(state, (layout) => setSplitRatioInLayout(layout, splitId, ratio)),
    );
  },
}));

useChatSplitLayoutStore.subscribe((state, previous) => {
  if (
    state.activeLayoutId === previous.activeLayoutId &&
    state.layoutsById === previous.layoutsById
  ) {
    return;
  }
  debouncedPersistState.maybeExecute({
    activeLayoutId: state.activeLayoutId,
    layoutsById: state.layoutsById,
  });
});

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}

export function getActiveChatSplitLayout(): ChatSplitLayout | null {
  return selectActiveChatSplitLayout(useChatSplitLayoutStore.getState());
}

export function getFocusedChatSplitTarget(): ThreadRouteTarget | null {
  const activeLayout = getActiveChatSplitLayout();
  return activeLayout ? getFocusedLeafTarget(activeLayout) : null;
}

export function getFocusedChatSplitDiffState(): DiffRouteSearch {
  const activeLayout = getActiveChatSplitLayout();
  const focusedLeaf = activeLayout ? getFocusedLeaf(activeLayout) : null;
  return focusedLeaf?.diff ?? {};
}

export function shouldSyncFocusedDiff(
  nextDiff: DiffRouteSearch,
  currentDiff: DiffRouteSearch,
): boolean {
  return !diffRouteStatesEqual(nextDiff, currentDiff);
}

export function hasLeafForTarget(target: ThreadRouteTarget): boolean {
  const activeLayout = getActiveChatSplitLayout();
  return Boolean(activeLayout && findLeafNodeByTarget(activeLayout, target));
}
