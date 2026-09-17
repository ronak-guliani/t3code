import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { DevicePlatform, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

const PREVIEW_MINI_PLAYER_STORAGE_KEY = "t3code:preview-mini-player:v1";

export interface PreviewMiniPlayerPosition {
  readonly x: number;
  readonly y: number;
}

export interface PreviewMiniPlayerSize {
  readonly width: number;
  readonly height: number;
}

export type PreviewMiniPlayerSource =
  | { readonly kind: "browser"; readonly tabId: string }
  | {
      readonly kind: "device";
      readonly hostId: string;
      readonly deviceId: string;
      readonly platform: DevicePlatform;
      readonly name: string;
      readonly serverEpoch?: string;
    };

export interface PreviewMiniPlayerState {
  readonly source: PreviewMiniPlayerSource;
  readonly position: PreviewMiniPlayerPosition | null;
  readonly width: number | null;
}

interface PreviewMiniPlayerStoreState {
  readonly byThreadKey: Readonly<Record<string, PreviewMiniPlayerState>>;
  readonly open: (ref: ScopedThreadRef, source: PreviewMiniPlayerSource) => void;
  readonly close: (ref: ScopedThreadRef) => void;
  readonly reconcileDeviceSession: (
    ref: ScopedThreadRef,
    source: PreviewMiniPlayerSource,
    serverEpoch: string,
    sessionExists: boolean,
  ) => void;
  readonly move: (
    ref: ScopedThreadRef,
    sourceKey: string,
    position: PreviewMiniPlayerPosition,
  ) => void;
  readonly resize: (ref: ScopedThreadRef, sourceKey: string, width: number) => void;
  readonly removeThread: (ref: ScopedThreadRef) => void;
}

interface PersistedPreviewMiniPlayerState {
  readonly byThreadKey: Readonly<Record<string, PreviewMiniPlayerState>>;
}

export function previewMiniPlayerSourceKey(source: PreviewMiniPlayerSource): string {
  return source.kind === "browser"
    ? `browser:${source.tabId}`
    : `device:${encodeURIComponent(source.hostId)}:${encodeURIComponent(source.deviceId)}`;
}

export const browserMiniPlayerSource = (tabId: string): PreviewMiniPlayerSource => ({
  kind: "browser",
  tabId,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const parsePosition = (value: unknown): PreviewMiniPlayerPosition | null | undefined => {
  if (value === null) return null;
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return undefined;
  return { x: value.x, y: value.y };
};

const parseWidth = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  return isFiniteNumber(value) && value > 0 ? value : undefined;
};

const parseSource = (value: unknown): PreviewMiniPlayerSource | undefined => {
  if (!isRecord(value) || (value.kind !== "browser" && value.kind !== "device")) return undefined;
  if (value.kind === "browser") {
    return typeof value.tabId === "string" && value.tabId.length > 0
      ? { kind: "browser", tabId: value.tabId }
      : undefined;
  }
  return typeof value.hostId === "string" &&
    value.hostId.length > 0 &&
    typeof value.deviceId === "string" &&
    value.deviceId.length > 0 &&
    (value.platform === "ios" || value.platform === "android") &&
    typeof value.name === "string" &&
    value.name.length > 0
    ? {
        kind: "device",
        hostId: value.hostId,
        deviceId: value.deviceId,
        platform: value.platform,
        name: value.name,
        ...(typeof value.serverEpoch === "string" && value.serverEpoch.length > 0
          ? { serverEpoch: value.serverEpoch }
          : {}),
      }
    : undefined;
};

export function normalizePersistedPreviewMiniPlayerState(
  value: unknown,
): PersistedPreviewMiniPlayerState {
  if (!isRecord(value) || !isRecord(value.byThreadKey)) return { byThreadKey: {} };
  const byThreadKey: Record<string, PreviewMiniPlayerState> = {};
  for (const [threadKey, candidate] of Object.entries(value.byThreadKey)) {
    if (parseScopedThreadKey(threadKey) === null || !isRecord(candidate)) continue;
    const source =
      parseSource(candidate.source) ??
      (typeof candidate.tabId === "string" && candidate.tabId.length > 0
        ? browserMiniPlayerSource(candidate.tabId)
        : undefined);
    const position = parsePosition(candidate.position);
    const width = parseWidth(
      candidate.width ?? (isRecord(candidate.size) ? candidate.size.width : null),
    );
    if (!source || position === undefined || width === undefined) continue;
    byThreadKey[threadKey] = { source, position, width };
  }
  return { byThreadKey };
}

const createPreviewMiniPlayerStorage = () =>
  resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);

export const usePreviewMiniPlayerStore = create<PreviewMiniPlayerStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      open: (ref, source) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const current = state.byThreadKey[key];
          if (
            current &&
            previewMiniPlayerSourceKey(current.source) === previewMiniPlayerSourceKey(source)
          ) {
            return state;
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [key]: {
                source,
                position: current?.position ?? null,
                width: current?.width ?? null,
              },
            },
          };
        }),
      close: (ref) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          if (!(key in state.byThreadKey)) return state;
          const { [key]: _closed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
      reconcileDeviceSession: (ref, source, serverEpoch, sessionExists) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const current = state.byThreadKey[key];
          if (!serverEpoch || !current || current.source.kind !== "device") return state;
          if (current.source !== source) return state;
          if (current.source.serverEpoch === serverEpoch && sessionExists) return state;
          if (!sessionExists) {
            if (current.source.serverEpoch !== serverEpoch) return state;
            const { [key]: _closed, ...byThreadKey } = state.byThreadKey;
            return { byThreadKey };
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [key]: { ...current, source: { ...current.source, serverEpoch } },
            },
          };
        }),
      move: (ref, sourceKey, position) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const current = state.byThreadKey[key];
          if (!current || previewMiniPlayerSourceKey(current.source) !== sourceKey) return state;
          if (current.position?.x === position.x && current.position.y === position.y) return state;
          return { byThreadKey: { ...state.byThreadKey, [key]: { ...current, position } } };
        }),
      resize: (ref, sourceKey, width) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const current = state.byThreadKey[key];
          if (
            !current ||
            previewMiniPlayerSourceKey(current.source) !== sourceKey ||
            current.width === width
          ) {
            return state;
          }
          return { byThreadKey: { ...state.byThreadKey, [key]: { ...current, width } } };
        }),
      removeThread: (ref) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          if (!(key in state.byThreadKey)) return state;
          const { [key]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
    }),
    {
      name: PREVIEW_MINI_PLAYER_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createPreviewMiniPlayerStorage),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizePersistedPreviewMiniPlayerState(persistedState),
      }),
    },
  ),
);

export function selectThreadPreviewMiniPlayer(
  byThreadKey: Readonly<Record<string, PreviewMiniPlayerState>>,
  ref: ScopedThreadRef | null | undefined,
): PreviewMiniPlayerState | null {
  if (!ref) return null;
  return byThreadKey[scopedThreadKey(ref)] ?? null;
}

export function selectThreadPreviewMiniPlayerTabId(
  byThreadKey: Readonly<Record<string, PreviewMiniPlayerState>>,
  ref: ScopedThreadRef | null | undefined,
): string | null {
  const source = selectThreadPreviewMiniPlayer(byThreadKey, ref)?.source;
  return source?.kind === "browser" ? source.tabId : null;
}
