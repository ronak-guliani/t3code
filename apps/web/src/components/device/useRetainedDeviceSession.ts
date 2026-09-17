import type { DeviceSummary, ScopedThreadRef } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { DeviceTabTarget } from "~/rightPanelStore";
import { formatEnvironmentQueryError } from "~/state/query";

export function shouldRecoverDeviceTarget(
  targetServerEpoch: string | undefined,
  currentServerEpoch: string | undefined,
): boolean {
  return Boolean(currentServerEpoch) && targetServerEpoch !== currentServerEpoch;
}

interface UseRetainedDeviceSessionOptions {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly threadId: ScopedThreadRef["threadId"];
  readonly enabled: boolean;
  readonly currentServerEpoch: string | undefined;
  readonly target: DeviceTabTarget | null | undefined;
  readonly sessionExists: boolean;
  readonly retryKey?: number;
  readonly listDevices: () => Promise<
    | { _tag: "Failure"; cause: Cause.Cause<unknown> }
    | { _tag: "Success"; value: { devices: ReadonlyArray<DeviceSummary> } }
  >;
  readonly openDevice: (input: {
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly input: {
      readonly threadId: ScopedThreadRef["threadId"];
      readonly hostId: string;
      readonly deviceId: string;
      readonly platform: DeviceSummary["platform"];
    };
  }) => Promise<
    { _tag: "Failure"; cause: Cause.Cause<unknown> } | { _tag: "Success"; value: unknown }
  >;
  readonly onRecoveryResult: (error: string | null) => void;
}

export function useRetainedDeviceSession(options: UseRetainedDeviceSessionOptions): boolean {
  const { environmentId, threadId, enabled, currentServerEpoch, target, sessionExists, retryKey } =
    options;
  const [recovering, setRecovering] = useState(false);
  const attempted = useRef<string | null>(null);
  const callbacks = useRef(options);
  useLayoutEffect(() => {
    callbacks.current = options;
  });
  const hostId = target?.hostId;
  const deviceId = target?.deviceId;
  const name = target?.name;
  const targetEpoch = target?.serverEpoch;

  useEffect(() => {
    if (
      !enabled ||
      !hostId ||
      !deviceId ||
      sessionExists ||
      !shouldRecoverDeviceTarget(targetEpoch, currentServerEpoch)
    ) {
      attempted.current = null;
      setRecovering(false);
      return;
    }
    const key = JSON.stringify([
      environmentId,
      threadId,
      hostId,
      deviceId,
      currentServerEpoch,
      retryKey,
    ]);
    if (attempted.current === key) return;
    attempted.current = key;
    let cancelled = false;
    let settled = false;
    const { listDevices, openDevice, onRecoveryResult } = callbacks.current;
    setRecovering(true);
    onRecoveryResult(null);
    void (async () => {
      const listed = await listDevices();
      if (cancelled) return;
      if (listed._tag === "Failure") {
        onRecoveryResult(formatEnvironmentQueryError(listed.cause));
        return;
      }
      const device = listed.value.devices.find(
        (candidate) => candidate.hostId === hostId && candidate.id === deviceId,
      );
      if (!device) {
        onRecoveryResult(
          `${name ?? "The retained device"} is not currently available. Refresh devices to retry.`,
        );
        return;
      }
      const reopened = await openDevice({
        environmentId,
        input: { threadId, hostId, deviceId, platform: device.platform },
      });
      if (!cancelled && reopened._tag === "Failure") {
        onRecoveryResult(formatEnvironmentQueryError(reopened.cause));
      }
    })()
      .catch((error: unknown) => {
        if (!cancelled) onRecoveryResult(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        settled = true;
        if (!cancelled) setRecovering(false);
      });
    return () => {
      cancelled = true;
      if (!settled && attempted.current === key) attempted.current = null;
    };
  }, [
    currentServerEpoch,
    deviceId,
    enabled,
    environmentId,
    hostId,
    name,
    retryKey,
    sessionExists,
    targetEpoch,
    threadId,
  ]);

  return recovering;
}
