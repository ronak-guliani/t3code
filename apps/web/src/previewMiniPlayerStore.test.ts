import type { ScopedThreadRef } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { scopedThreadKey } from "@t3tools/client-runtime";
import { createJSONStorage } from "zustand/middleware";

import {
  browserMiniPlayerSource,
  normalizePersistedPreviewMiniPlayerState,
  previewMiniPlayerSourceKey,
  usePreviewMiniPlayerStore,
} from "./previewMiniPlayerStore";
import { createMemoryStorage } from "./lib/storage";

const first = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};
const second = { ...first, threadId: "thread-2" as ScopedThreadRef["threadId"] };

beforeEach(() => usePreviewMiniPlayerStore.setState({ byThreadKey: {} }));

describe("previewMiniPlayerStore", () => {
  it("keeps player state scoped to its thread and preserves its layout across tab changes", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(first, browserMiniPlayerSource("tab-a"));
    store.move(first, previewMiniPlayerSourceKey(browserMiniPlayerSource("tab-a")), {
      x: 20,
      y: 30,
    });
    store.resize(first, previewMiniPlayerSourceKey(browserMiniPlayerSource("tab-a")), 360);
    store.open(first, browserMiniPlayerSource("tab-b"));
    store.open(second, browserMiniPlayerSource("tab-c"));

    const entries = usePreviewMiniPlayerStore.getState().byThreadKey;
    expect(Object.values(entries)).toEqual(
      expect.arrayContaining([
        {
          source: browserMiniPlayerSource("tab-b"),
          position: { x: 20, y: 30 },
          width: 360,
        },
        { source: browserMiniPlayerSource("tab-c"), position: null, width: null },
      ]),
    );
  });

  it("drops stale tab drag and resize events", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(first, browserMiniPlayerSource("tab-current"));
    store.move(first, previewMiniPlayerSourceKey(browserMiniPlayerSource("tab-stale")), {
      x: 20,
      y: 30,
    });
    store.resize(first, previewMiniPlayerSourceKey(browserMiniPlayerSource("tab-stale")), 360);

    expect(Object.values(usePreviewMiniPlayerStore.getState().byThreadKey)).toEqual([
      { source: browserMiniPlayerSource("tab-current"), position: null, width: null },
    ]);
  });

  it("removes only the deleted thread's floating preview", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(first, browserMiniPlayerSource("tab-a"));
    store.open(second, browserMiniPlayerSource("tab-b"));
    store.removeThread(first);

    expect(Object.values(usePreviewMiniPlayerStore.getState().byThreadKey)).toEqual([
      { source: browserMiniPlayerSource("tab-b"), position: null, width: null },
    ]);
  });

  it("no-ops equal move and resize values", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(first, browserMiniPlayerSource("tab-a"));
    store.move(first, previewMiniPlayerSourceKey(browserMiniPlayerSource("tab-a")), {
      x: 20,
      y: 30,
    });
    store.resize(first, previewMiniPlayerSourceKey(browserMiniPlayerSource("tab-a")), 360);
    const before = usePreviewMiniPlayerStore.getState().byThreadKey;

    store.move(first, previewMiniPlayerSourceKey(browserMiniPlayerSource("tab-a")), {
      x: 20,
      y: 30,
    });
    store.resize(first, previewMiniPlayerSourceKey(browserMiniPlayerSource("tab-a")), 360);

    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toBe(before);
  });

  it("keeps device identity scoped by host when replacing the source", () => {
    const store = usePreviewMiniPlayerStore.getState();
    const firstDevice = {
      kind: "device" as const,
      hostId: "local",
      deviceId: "sim-1",
      platform: "ios" as const,
      name: "iPhone",
    };
    const secondDevice = { ...firstDevice, hostId: "ssh-host" };
    store.open(first, firstDevice);
    store.open(first, secondDevice);

    expect(usePreviewMiniPlayerStore.getState().byThreadKey[scopedThreadKey(first)]).toEqual({
      source: secondDevice,
      position: null,
      width: null,
    });
    expect(previewMiniPlayerSourceKey(firstDevice)).not.toBe(
      previewMiniPlayerSourceKey(secondDevice),
    );
  });

  it("persists only valid thread-scoped floating preview state", () => {
    expect(
      normalizePersistedPreviewMiniPlayerState({
        byThreadKey: {
          [scopedThreadKey(first)]: {
            source: browserMiniPlayerSource("tab-a"),
            position: { x: 20, y: 30 },
            width: 360,
          },
          invalid: {
            source: browserMiniPlayerSource("tab-b"),
            position: null,
            width: null,
          },
          [scopedThreadKey(second)]: {
            source: browserMiniPlayerSource(""),
            position: null,
            width: null,
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        [scopedThreadKey(first)]: {
          source: browserMiniPlayerSource("tab-a"),
          position: { x: 20, y: 30 },
          width: 360,
        },
      },
    });
  });

  it("restores floating preview state after the store is rehydrated", async () => {
    const options = usePreviewMiniPlayerStore.persist.getOptions();
    if (!options.name) throw new Error("Expected preview mini-player persistence to have a name.");
    const storage = createMemoryStorage();
    storage.setItem(
      options.name,
      JSON.stringify({
        state: {
          byThreadKey: {
            [scopedThreadKey(first)]: {
              source: browserMiniPlayerSource("tab-a"),
              position: { x: 20, y: 30 },
              width: 360,
            },
          },
        },
        version: 1,
      }),
    );

    try {
      usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
      usePreviewMiniPlayerStore.persist.setOptions({
        storage: createJSONStorage(() => storage),
      });

      await usePreviewMiniPlayerStore.persist.rehydrate();

      expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({
        [scopedThreadKey(first)]: {
          source: browserMiniPlayerSource("tab-a"),
          position: { x: 20, y: 30 },
          width: 360,
        },
      });
    } finally {
      usePreviewMiniPlayerStore.persist.setOptions(options);
    }
  });
});
