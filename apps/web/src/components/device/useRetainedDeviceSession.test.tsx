import { EnvironmentId, ThreadId, type DeviceSummary } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useRetainedDeviceSession } from "./useRetainedDeviceSession";

const device: DeviceSummary = {
  hostId: "local",
  id: "sim-1",
  platform: "ios",
  name: "iPhone",
  version: "18",
  booted: true,
  physical: false,
};
const target = {
  hostId: device.hostId,
  deviceId: device.id,
  platform: device.platform,
  name: device.name,
  serverEpoch: "a",
};
const listDevices = vi.fn(async () => ({ _tag: "Success" as const, value: { devices: [device] } }));
const openDevice = vi.fn(async () => ({ _tag: "Success" as const, value: {} }));
const onRecoveryResult = vi.fn();
let renderer: ReactTestRenderer | undefined;
let recovering = false;
const defaults = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread-1"),
  enabled: true,
  currentServerEpoch: "b",
  target,
  sessionExists: false,
  listDevices,
  openDevice,
  onRecoveryResult,
};
function Probe(props: Partial<Parameters<typeof useRetainedDeviceSession>[0]>) {
  recovering = useRetainedDeviceSession({ ...defaults, ...props });
  return null;
}
async function render(props: Partial<Parameters<typeof useRetainedDeviceSession>[0]> = {}) {
  await act(async () => {
    if (renderer) renderer.update(<Probe {...props} />);
    else renderer = create(<Probe {...props} />);
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listDevices.mockClear();
  openDevice.mockClear();
  onRecoveryResult.mockClear();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
it("lists and reopens once per epoch, including subsequent restarts", async () => {
  await render();
  expect(openDevice).toHaveBeenCalledWith({
    environmentId: defaults.environmentId,
    input: {
      threadId: defaults.threadId,
      hostId: "local",
      deviceId: "sim-1",
      platform: "ios",
    },
  });
  await render({ target: { ...target } });
  expect(openDevice).toHaveBeenCalledTimes(1);
  await render({ currentServerEpoch: "c" });
  expect(openDevice).toHaveBeenCalledTimes(2);
  expect(recovering).toBe(false);
});
it("does not reopen explicit same-epoch closures or run before hydration", async () => {
  await render({ currentServerEpoch: "a" });
  await render({ currentServerEpoch: undefined });
  await render({ enabled: false });
  expect(listDevices).not.toHaveBeenCalled();
});
it("recovers legacy retained sources without an epoch", async () => {
  const { serverEpoch: _, ...legacy } = target;
  await render({ target: legacy });
  expect(openDevice).toHaveBeenCalledTimes(1);
});
it("keeps failures bounded and permits an explicit retry", async () => {
  listDevices.mockResolvedValueOnce({ _tag: "Success", value: { devices: [] } });
  await render();
  expect(onRecoveryResult).toHaveBeenLastCalledWith(
    expect.stringContaining("not currently available"),
  );
  expect(openDevice).not.toHaveBeenCalled();
  await render({ target: { ...target } });
  expect(listDevices).toHaveBeenCalledTimes(1);
  await render({ retryKey: 1 });
  expect(openDevice).toHaveBeenCalledTimes(1);
});
it("does not reopen a target dismissed while discovery is pending", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof listDevices>>) => void;
  listDevices.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render();
  expect(recovering).toBe(true);
  await render({ target: null });
  await act(async () => resolve({ _tag: "Success", value: { devices: [device] } }));
  expect(openDevice).not.toHaveBeenCalled();
  expect(recovering).toBe(false);
});
