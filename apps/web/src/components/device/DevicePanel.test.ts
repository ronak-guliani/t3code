import { describe, expect, it } from "vite-plus/test";

import { shouldRecoverDeviceTarget } from "./DevicePanel";

describe("DevicePanel recovery", () => {
  it("recovers retained targets only after the Device service restarts", () => {
    expect(shouldRecoverDeviceTarget("server-a", "server-a")).toBe(false);
    expect(shouldRecoverDeviceTarget("server-a", "server-b")).toBe(true);
    expect(shouldRecoverDeviceTarget(undefined, "server-b")).toBe(true);
  });
});
