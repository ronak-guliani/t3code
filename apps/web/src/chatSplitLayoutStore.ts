import { Debouncer } from "@tanstack/react-pacer";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

import type { DiffRouteSearch } from "./diffRouteSearch";
import {
  type ChatSplitFocusDirection,
  type ChatSplitDropPlacement,
  type ChatSplitLayout,
  type ChatSplitNode,
  type ChatSplitNodeId,
  type ChatSplitOrientation,
  buildChatSplitLayoutFromTargets,
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
  splitLeafWithTarget,
  syncLayoutWithRouteTarget,
  toggleLeafMaximized,
} from "./chatSplitLayout";
import type { ThreadRouteTarget } from "./threadRoutes";
import type { DraftId } from "./composerDraftStore";

export const CHAT_SPLIT_LAYOUT_STORAGE_KEY = "t3code:chat-split-layout:v1";
export const DEFAULT_CHAT_SPLIT_LAYOUT_ID = "default";

export function deriveChatSplitLayoutId(target: ThreadRouteTarget): string {
  return target.kind === "server"
    ? `environment:${target.threadRef.environmentId}`
    : `draft:${target.draftId}`;
}

function isLayoutIdInTargetScope(layoutId: string, target: ThreadRouteTarget): boolean {
  const baseLayoutId = deriveChatSplitLayoutId(target);
  return target.kind === "server"
    ? layoutId === baseLayoutId || layoutId.startsWith(`${baseLayoutId}:workspace:`)
    : layoutId === baseLayoutId;
}

function createWorkspaceLayoutId(
  target: ThreadRouteTarget,
  existingLayouts: Record<string, ChatSplitLayout>,
): string {
  const baseLayoutId = deriveChatSplitLayoutId(target);
  if (target.kind !== "server") {
    return baseLayoutId;
  }

  let index = 1;
  let nextLayoutId = `${baseLayoutId}:workspace:${index}`;
  while (existingLayouts[nextLayoutId]) {
    index += 1;
    nextLayoutId = `${baseLayoutId}:workspace:${index}`;
  }
  return nextLayoutId;
}

function getScopedLayoutIds(
  state: Pick<ChatSplitLayoutStoreState, "layoutsById">,
  target: ThreadRouteTarget,
): string[] {
  return Object.keys(state.layoutsById).filter((layoutId) =>
    isLayoutIdInTargetScope(layoutId, target),
  );
}

function getLayoutActivationSequence(
  state: Pick<ChatSplitLayoutStoreState, "layoutActivationSequenceById">,
  layoutId: string,
): number {
  return state.layoutActivationSequenceById[layoutId] ?? 0;
}

function sortLayoutIdsByActivation(
  state: Pick<ChatSplitLayoutStoreState, "layoutActivationSequenceById">,
  layoutIds: readonly string[],
): string[] {
  return [...layoutIds].toSorted(
    (left, right) =>
      getLayoutActivationSequence(state, right) - getLayoutActivationSequence(state, left),
  );
}

function activateLayout(
  state: ChatSplitLayoutStoreState,
  layoutId: string,
): ChatSplitLayoutStoreState {
  if (state.activeLayoutId === layoutId) {
    return state;
  }

  const nextLayoutActivationSequence = state.nextLayoutActivationSequence + 1;
  return {
    ...state,
    activeLayoutId: layoutId,
    nextLayoutActivationSequence,
    layoutActivationSequenceById: {
      ...state.layoutActivationSequenceById,
      [layoutId]: nextLayoutActivationSequence,
    },
  };
}

function pickPreferredLayoutIdForTarget(
  state: Pick<
    ChatSplitLayoutStoreState,
    "activeLayoutId" | "layoutsById" | "layoutActivationSequenceById"
  >,
  target: ThreadRouteTarget,
): string | null {
  const scopedLayoutIds = getScopedLayoutIds(state, target);
  if (scopedLayoutIds.length === 0) {
    return null;
  }

  const activeLayoutId = isLayoutIdInTargetScope(state.activeLayoutId, target)
    ? state.activeLayoutId
    : null;
  if (activeLayoutId) {
    return activeLayoutId;
  }

  const baseLayoutId = deriveChatSplitLayoutId(target);
  if (state.layoutsById[baseLayoutId]) {
    return baseLayoutId;
  }

  return sortLayoutIdsByActivation(state, scopedLayoutIds)[0] ?? null;
}

function allTargetsShareSplitScope(targets: readonly ThreadRouteTarget[]): boolean {
  const [firstTarget, ...remainingTargets] = targets;
  if (!firstTarget) {
    return false;
  }
  if (firstTarget.kind !== "server") {
    return targets.length === 1;
  }
  return remainingTargets.every(
    (target) =>
      target.kind === "server" &&
      target.threadRef.environmentId === firstTarget.threadRef.environmentId,
  );
}

function layoutContainsAnyTarget(
  layout: ChatSplitLayout,
  targets: readonly ThreadRouteTarget[],
): boolean {
  return targets.some((target) => findLeafNodeByTarget(layout, target) !== null);
}

interface PersistedChatSplitLayoutDocument {
  activeLayoutId?: string;
  layoutsById?: Record<string, unknown>;
  layoutActivationSequenceById?: Record<string, unknown>;
  nextLayoutActivationSequence?: unknown;
}

interface ChatSplitLayoutStoreState {
  activeLayoutId: string;
  layoutsById: Record<string, ChatSplitLayout>;
  layoutActivationSequenceById: Record<string, number>;
  nextLayoutActivationSequence: number;
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
  unsplitFocusedLeaf: () => ThreadRouteTarget | null;
  openWorkspaceFromTargets: (
    targets: readonly ThreadRouteTarget[],
    orientation: ChatSplitOrientation,
  ) => ThreadRouteTarget | null;
  dropTargetIntoLeaf: (
    leafId: ChatSplitNodeId,
    target: ThreadRouteTarget,
    placement: ChatSplitDropPlacement,
  ) => ThreadRouteTarget | null;
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
    const target = value.target === null ? null : sanitizePersistedTarget(value.target);
    if (value.target !== null && !target) {
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
  "activeLayoutId" | "layoutsById" | "layoutActivationSequenceById" | "nextLayoutActivationSequence"
> {
  if (typeof window === "undefined") {
    return {
      activeLayoutId: DEFAULT_CHAT_SPLIT_LAYOUT_ID,
      layoutsById: {},
      layoutActivationSequenceById: {},
      nextLayoutActivationSequence: 0,
    };
  }

  try {
    const raw = window.localStorage.getItem(CHAT_SPLIT_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return {
        activeLayoutId: DEFAULT_CHAT_SPLIT_LAYOUT_ID,
        layoutsById: {},
        layoutActivationSequenceById: {},
        nextLayoutActivationSequence: 0,
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

    const rawActivationMap = isRecord(parsed.layoutActivationSequenceById)
      ? parsed.layoutActivationSequenceById
      : {};
    const layoutActivationSequenceById = Object.fromEntries(
      Object.keys(layoutsById).map((layoutId, index) => {
        const rawSequence = rawActivationMap[layoutId];
        return [
          layoutId,
          typeof rawSequence === "number" && Number.isFinite(rawSequence) && rawSequence > 0
            ? rawSequence
            : index + 1,
        ] as const;
      }),
    );
    const persistedNextActivationSequence =
      typeof parsed.nextLayoutActivationSequence === "number" &&
      Number.isFinite(parsed.nextLayoutActivationSequence) &&
      parsed.nextLayoutActivationSequence > 0
        ? parsed.nextLayoutActivationSequence
        : 0;
    const baseActivationSequence = Math.max(
      persistedNextActivationSequence,
      ...Object.values(layoutActivationSequenceById),
    );
    const nextLayoutActivationSequence =
      activeLayoutId in layoutActivationSequenceById
        ? baseActivationSequence + 1
        : baseActivationSequence;
    if (activeLayoutId in layoutActivationSequenceById) {
      layoutActivationSequenceById[activeLayoutId] = nextLayoutActivationSequence;
    }

    return {
      activeLayoutId,
      layoutsById,
      layoutActivationSequenceById,
      nextLayoutActivationSequence,
    };
  } catch {
    return {
      activeLayoutId: DEFAULT_CHAT_SPLIT_LAYOUT_ID,
      layoutsById: {},
      layoutActivationSequenceById: {},
      nextLayoutActivationSequence: 0,
    };
  }
}

export function persistChatSplitLayoutState(
  state: Pick<
    ChatSplitLayoutStoreState,
    | "activeLayoutId"
    | "layoutsById"
    | "layoutActivationSequenceById"
    | "nextLayoutActivationSequence"
  >,
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
        layoutActivationSequenceById: state.layoutActivationSequenceById,
        nextLayoutActivationSequence: state.nextLayoutActivationSequence,
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

function createSingleLeafLayout(
  target: ThreadRouteTarget,
  diff?: DiffRouteSearch,
): ChatSplitLayout {
  return createInitialChatSplitLayout({
    leafId: createNodeId(),
    target,
    ...(diff !== undefined ? { diff } : {}),
  });
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
      const nextLayoutId =
        pickPreferredLayoutIdForTarget(state, target) ?? deriveChatSplitLayoutId(target);
      const activeLayout = state.layoutsById[nextLayoutId] ?? null;
      if (!activeLayout) {
        const nextState = {
          ...state,
          layoutsById: {
            ...state.layoutsById,
            [nextLayoutId]: createSingleLeafLayout(target, diff),
          },
        };
        return activateLayout(nextState, nextLayoutId);
      }

      const nextLayout = syncLayoutWithRouteTarget(activeLayout, target, diff);
      if (nextLayout === activeLayout) {
        return activateLayout(state, nextLayoutId);
      }
      const nextState = {
        ...state,
        layoutsById: {
          ...state.layoutsById,
          [nextLayoutId]: nextLayout,
        },
      };
      return activateLayout(nextState, nextLayoutId);
    });
  },
  focusLeaf: (leafId) => {
    const activeLayout = selectActiveChatSplitLayout(get());
    const leaf = activeLayout ? getLeafNode(activeLayout, leafId) : null;
    if (!leaf) {
      return null;
    }
    set((state) => updateActiveLayout(state, (layout) => focusLeafInLayout(layout, leafId)));
    return leaf.target;
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
  unsplitFocusedLeaf: () => {
    const activeLayout = selectActiveChatSplitLayout(get());
    const focusedLeaf = activeLayout ? getFocusedLeaf(activeLayout) : null;
    if (!focusedLeaf?.target) {
      return null;
    }
    const target = focusedLeaf.target;
    const diff = focusedLeaf.diff;

    set((state) => updateActiveLayout(state, () => createSingleLeafLayout(target, diff)));
    return target;
  },
  openWorkspaceFromTargets: (targets, orientation) => {
    const [firstTarget] = targets;
    if (!firstTarget || !allTargetsShareSplitScope(targets)) {
      return null;
    }

    const nextLayout = buildChatSplitLayoutFromTargets({
      targets,
      orientation,
      createId: createNodeId,
    });
    if (!nextLayout) {
      return null;
    }

    const focusedTarget = getFocusedLeafTarget(nextLayout);
    if (!focusedTarget) {
      return null;
    }

    set((state) => {
      const activeLayout = selectActiveChatSplitLayout(state);
      const shouldReplaceActiveLayout =
        activeLayout !== null &&
        isLayoutIdInTargetScope(state.activeLayoutId, firstTarget) &&
        layoutContainsAnyTarget(activeLayout, targets);
      const nextLayoutId = shouldReplaceActiveLayout
        ? state.activeLayoutId
        : createWorkspaceLayoutId(firstTarget, state.layoutsById);
      const nextState = {
        ...state,
        layoutsById: {
          ...state.layoutsById,
          [nextLayoutId]: nextLayout,
        },
      };
      return activateLayout(nextState, nextLayoutId);
    });

    return focusedTarget;
  },
  dropTargetIntoLeaf: (leafId, target, placement) => {
    const activeLayout = selectActiveChatSplitLayout(get());
    if (!activeLayout || !isLayoutIdInTargetScope(get().activeLayoutId, target)) {
      return null;
    }

    const existingLeaf = findLeafNodeByTarget(activeLayout, target);
    if (existingLeaf) {
      set((state) =>
        updateActiveLayout(state, (layout) => focusLeafInLayout(layout, existingLeaf.id)),
      );
      return target;
    }

    const targetLeaf = getLeafNode(activeLayout, leafId);
    if (!targetLeaf) {
      return null;
    }

    if (!targetLeaf.target) {
      set((state) =>
        updateActiveLayout(state, (layout) => replaceLeafTargetInLayout(layout, leafId, target)),
      );
      return target;
    }

    set((state) =>
      updateActiveLayout(state, (layout) =>
        splitLeafWithTarget(layout, leafId, target, placement, createNodeId),
      ),
    );
    return target;
  },
  closeFocusedLeaf: () => {
    const activeLayout = selectActiveChatSplitLayout(get());
    if (!activeLayout || countLeafNodes(activeLayout) <= 1) {
      return null;
    }

    const nextLayout = closeLeaf(activeLayout, activeLayout.focusedLeafId);
    const nextTarget = getFocusedLeafTarget(nextLayout);
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
    state.layoutsById === previous.layoutsById &&
    state.layoutActivationSequenceById === previous.layoutActivationSequenceById &&
    state.nextLayoutActivationSequence === previous.nextLayoutActivationSequence
  ) {
    return;
  }
  debouncedPersistState.maybeExecute({
    activeLayoutId: state.activeLayoutId,
    layoutsById: state.layoutsById,
    layoutActivationSequenceById: state.layoutActivationSequenceById,
    nextLayoutActivationSequence: state.nextLayoutActivationSequence,
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
