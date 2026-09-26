import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { DeviceServiceState, ScopedThreadRef } from "@t3tools/contracts";

import { usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import { useRightPanelStore } from "../../rightPanelStore";

export function reconcileDeviceSessionPresentation(
  previousSessions: Map<string, Set<string>>,
  {
    activeThreadRef,
    deviceState,
    loaded,
    floating,
    sheet,
  }: {
    activeThreadRef: ScopedThreadRef | null;
    deviceState: Pick<DeviceServiceState, "sessions" | "devices" | "serverEpoch">;
    loaded: boolean;
    floating: boolean;
    sheet: boolean;
  },
): void {
  if (!activeThreadRef || !loaded) return;
  const sessions = deviceState.sessions.filter(
    (session) => session.threadId === activeThreadRef.threadId,
  );
  const threadKey = scopedThreadKey(activeThreadRef);
  const key = (session: (typeof sessions)[number]) => `${session.hostId}\u0000${session.deviceId}`;
  const deviceFor = (session: (typeof sessions)[number]) =>
    deviceState.devices.find(
      (candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId,
    );
  const previous = previousSessions.get(threadKey);
  previousSessions.set(
    threadKey,
    new Set(sessions.filter((session) => deviceFor(session) !== undefined).map(key)),
  );
  if (sheet) return;
  for (const session of sessions) {
    if (previous?.has(key(session))) continue;
    const device = deviceFor(session);
    if (!device) continue;
    const target = {
      hostId: session.hostId,
      deviceId: session.deviceId,
      platform: session.platform,
      name: device.name,
      ...(deviceState.serverEpoch ? { serverEpoch: deviceState.serverEpoch } : {}),
    };
    if (floating) {
      usePreviewMiniPlayerStore.getState().open(activeThreadRef, {
        kind: "device",
        ...target,
      });
    } else {
      const existing = useRightPanelStore
        .getState()
        .byThreadKey[threadKey]?.surfaces.some(
          (surface) =>
            surface.kind === "device" &&
            surface.target?.hostId === session.hostId &&
            surface.target.deviceId === session.deviceId,
        );
      if (!existing) useRightPanelStore.getState().openDevice(activeThreadRef, target);
    }
  }
}
