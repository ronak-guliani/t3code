import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const routeModuleEvaluations = vi.hoisted(() => ({
  connectionsNew: 0,
}));

vi.mock("./features/connection/ConnectionsNewRouteScreen", () => {
  routeModuleEvaluations.connectionsNew += 1;
  return { ConnectionsNewRouteScreen: () => null };
});

afterEach(() => {
  vi.resetModules();
  routeModuleEvaluations.connectionsNew = 0;
});

describe("deferred route loaders", () => {
  it("does not evaluate a deferred route body until its loader is called", async () => {
    const { deferredRouteLoaders } = await import("./deferred-route-loaders");

    expect(routeModuleEvaluations.connectionsNew).toBe(0);
    await deferredRouteLoaders.connectionsNew();
    expect(routeModuleEvaluations.connectionsNew).toBe(1);
  });
});
