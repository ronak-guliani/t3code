import {
  EnvironmentId,
  type LocalApi,
  type PersistedSavedEnvironmentRecord,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  waitForSavedEnvironmentRegistryHydration,
  persistSavedEnvironmentEnabled,
} from "./catalog";

const writeRegistry = vi.fn(async (_records: readonly PersistedSavedEnvironmentRecord[]) => {});
const pauseRecord: PersistedSavedEnvironmentRecord = {
  environmentId: EnvironmentId.make("pause-host"),
  label: "Pause host",
  httpBaseUrl: "http://localhost:13775",
  wsBaseUrl: "ws://localhost:13775",
  createdAt: "2026-09-15T00:00:00Z",
  lastConnectedAt: null,
};

describe("environment runtime catalog stores", () => {
  beforeEach(async () => {
    writeRegistry.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("window", {
      nativeApi: {
        persistence: {
          getClientSettings: async () => null,
          setClientSettings: async () => undefined,
          getSavedEnvironmentRegistry: async () => [],
          setSavedEnvironmentRegistry: writeRegistry,
          getSavedEnvironmentSecret: async () => null,
          setSavedEnvironmentSecret: async () => true,
          removeSavedEnvironmentSecret: async () => undefined,
        },
      } satisfies Pick<LocalApi, "persistence">,
    });
    const { __resetLocalApiForTests } = await import("../../localApi");
    await __resetLocalApiForTests();
  });

  it("persists pause before publishing it and prevents a queued metadata write from re-enabling it", async () => {
    const environmentId = pauseRecord.environmentId;
    useSavedEnvironmentRegistryStore.setState({ byId: { [environmentId]: pauseRecord } });
    let finishWrite!: () => void;
    writeRegistry.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const pause = persistSavedEnvironmentEnabled(environmentId, false);
    await vi.waitFor(() => expect(writeRegistry).toHaveBeenCalled());
    expect(
      useSavedEnvironmentRegistryStore.getState().byId[environmentId]?.enabled,
    ).toBeUndefined();
    useSavedEnvironmentRegistryStore
      .getState()
      .markConnected(environmentId, "2026-09-15T00:01:00Z");
    finishWrite();
    await pause;
    await vi.waitFor(() =>
      expect(writeRegistry).toHaveBeenLastCalledWith([
        { ...pauseRecord, enabled: false, lastConnectedAt: "2026-09-15T00:01:00Z" },
      ]),
    );
    expect(useSavedEnvironmentRegistryStore.getState().byId[environmentId]?.enabled).toBe(false);
  });

  it("leaves enabled intent unchanged when persistence fails, then allows retry", async () => {
    const environmentId = pauseRecord.environmentId;
    useSavedEnvironmentRegistryStore.setState({ byId: { [environmentId]: pauseRecord } });
    writeRegistry.mockRejectedValueOnce(new Error("disk full"));
    await expect(persistSavedEnvironmentEnabled(environmentId, false)).rejects.toThrow("disk full");
    expect(
      useSavedEnvironmentRegistryStore.getState().byId[environmentId]?.enabled,
    ).toBeUndefined();
    await persistSavedEnvironmentEnabled(environmentId, false);
    await persistSavedEnvironmentEnabled(environmentId, true);
    expect(useSavedEnvironmentRegistryStore.getState().byId[environmentId]?.enabled).toBe(true);
  });

  afterEach(async () => {
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    const { __resetLocalApiForTests } = await import("../../localApi");
    await __resetLocalApiForTests();
    vi.unstubAllGlobals();
  });

  it("resets the saved environment registry store state", () => {
    const environmentId = EnvironmentId.make("environment-1");

    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId,
      label: "Remote environment",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      createdAt: "2026-04-09T00:00:00.000Z",
      lastConnectedAt: null,
    });

    expect(useSavedEnvironmentRegistryStore.getState().byId[environmentId]).toBeDefined();

    resetSavedEnvironmentRegistryStoreForTests();

    expect(useSavedEnvironmentRegistryStore.getState().byId).toEqual({});
  });

  it("resets the saved environment runtime store state", () => {
    const environmentId = EnvironmentId.make("environment-1");

    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      connectionState: "connected",
      connectedAt: "2026-04-09T00:00:00.000Z",
    });

    expect(useSavedEnvironmentRuntimeStore.getState().byId[environmentId]).toBeDefined();

    resetSavedEnvironmentRuntimeStoreForTests();

    expect(useSavedEnvironmentRuntimeStore.getState().byId).toEqual({});
  });

  it("does not throw when local api lookup fails during registry persistence", async () => {
    vi.unstubAllGlobals();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { __resetLocalApiForTests } = await import("../../localApi");
    await __resetLocalApiForTests();

    expect(() =>
      useSavedEnvironmentRegistryStore.getState().upsert({
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-09T00:00:00.000Z",
        lastConnectedAt: null,
      }),
    ).not.toThrow();

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        "[SAVED_ENVIRONMENTS] persist failed",
        expect.any(Error),
      ),
    );
  });

  it("does not let stale hydration overwrite records added while hydration is in flight", async () => {
    let resolveRegistryRead: () => void = () => {
      throw new Error("Registry read resolver was not initialized.");
    };

    vi.stubGlobal("window", {
      nativeApi: {
        persistence: {
          getClientSettings: async () => null,
          setClientSettings: async () => undefined,
          getSavedEnvironmentRegistry: () =>
            new Promise<readonly PersistedSavedEnvironmentRecord[]>((resolve) => {
              resolveRegistryRead = () => resolve([]);
            }),
          setSavedEnvironmentRegistry: async () => undefined,
          getSavedEnvironmentSecret: async () => null,
          setSavedEnvironmentSecret: async () => true,
          removeSavedEnvironmentSecret: async () => undefined,
        },
      } satisfies Pick<LocalApi, "persistence">,
    });

    const { __resetLocalApiForTests } = await import("../../localApi");
    await __resetLocalApiForTests();

    const hydrationPromise = waitForSavedEnvironmentRegistryHydration();

    const environmentId = EnvironmentId.make("environment-1");
    const record = {
      environmentId,
      label: "Remote environment",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      createdAt: "2026-04-09T00:00:00.000Z",
      lastConnectedAt: null,
    } as const;

    useSavedEnvironmentRegistryStore.getState().upsert(record);

    resolveRegistryRead();
    await hydrationPromise;

    expect(useSavedEnvironmentRegistryStore.getState().byId[environmentId]).toEqual(record);
  });
});
