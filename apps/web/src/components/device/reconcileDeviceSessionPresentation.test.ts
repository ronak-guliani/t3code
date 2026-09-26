import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type DeviceServiceState } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { reconcileDeviceSessionPresentation } from "./reconcileDeviceSessionPresentation";

const thread = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread-1"));
const threadKey = scopedThreadKey(thread);
const device = {
  hostId: "local",
  id: "sim-1",
  platform: "ios" as const,
  name: "iPhone",
  version: "18.0",
  booted: true,
  physical: false,
};
const snapshot: Pick<DeviceServiceState, "sessions" | "devices" | "serverEpoch"> = {
  serverEpoch: "server-a",
  devices: [device],
  sessions: [
    {
      threadId: thread.threadId,
      hostId: device.hostId,
      deviceId: device.id,
      platform: device.platform,
      openedAt: "2026-09-16T00:00:00.000Z",
    },
  ],
};
const target = {
  hostId: device.hostId,
  deviceId: device.id,
  platform: device.platform,
  name: device.name,
  serverEpoch: snapshot.serverEpoch,
};

beforeEach(() => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe.each([true, false])("device session presentation (floating=%s)", (floating) => {
  function setup() {
    const previous = new Map<string, Set<string>>();
    const reconcile = (
      deviceState = snapshot,
      options: { loaded?: boolean; sheet?: boolean; activeThreadRef?: typeof thread | null } = {},
    ) =>
      reconcileDeviceSessionPresentation(previous, {
        activeThreadRef: thread,
        deviceState,
        loaded: true,
        floating,
        sheet: false,
        ...options,
      });
    return { previous, reconcile };
  }

  function expectOpen() {
    if (floating) {
      expect(usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source).toEqual({
        kind: "device",
        ...target,
      });
      expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    } else {
      expect(useRightPanelStore.getState().byThreadKey[threadKey]).toMatchObject({
        isOpen: true,
        surfaces: [{ kind: "device", target }],
      });
      expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
    }
  }

  it("opens the configured surface on the first loaded active-session snapshot", () => {
    const { previous, reconcile } = setup();
    reconcile(snapshot, { loaded: false });
    expect(previous.size).toBe(0);
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    reconcile();
    expectOpen();
  });

  it("does not reopen dismissed surfaces on repeated snapshots", () => {
    const { reconcile } = setup();
    reconcile();
    expectOpen();
    usePreviewMiniPlayerStore.getState().close(thread);
    useRightPanelStore.getState().closeAllSurfaces(thread);
    reconcile({ ...snapshot, sessions: snapshot.sessions.map((session) => ({ ...session })) });
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("opens when matching device metadata arrives in a later snapshot", () => {
    const { reconcile } = setup();
    reconcile({ ...snapshot, devices: [{ ...device, hostId: "other-host" }] });
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    reconcile();
    expectOpen();
  });

  it("ignores other threads and reconciles when the active thread becomes available", () => {
    const { previous, reconcile } = setup();
    reconcile(snapshot, { activeThreadRef: null });
    expect(previous.size).toBe(0);
    reconcile({
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({
        ...session,
        threadId: ThreadId.make("other-thread"),
      })),
    });
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    reconcile();
    expectOpen();
  });

  it("preserves sheet-layout suppression", () => {
    const { reconcile } = setup();
    reconcile(snapshot, { sheet: true });
    reconcile();
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });
});
