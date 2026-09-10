import { describe, expect, it, vi } from "vite-plus/test";

import { createRetryableDeferredModule } from "./retryable-deferred-module";

describe("createRetryableDeferredModule", () => {
  it("deduplicates concurrent loads and reuses the resolved module", async () => {
    const gate = Promise.withResolvers<string>();
    const loader = vi.fn(() => gate.promise);
    const deferred = createRetryableDeferredModule(loader);

    const first = deferred.load();
    const second = deferred.load();
    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);

    gate.resolve("loaded");
    await expect(first).resolves.toBe("loaded");
    expect(deferred.peek()).toBe("loaded");
    await expect(deferred.load()).resolves.toBe("loaded");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("clears a rejected load so an explicit retry starts a new attempt", async () => {
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first load failed"))
      .mockResolvedValueOnce("recovered");
    const deferred = createRetryableDeferredModule(loader);

    await expect(deferred.load()).rejects.toThrow("first load failed");
    expect(deferred.peek()).toBeNull();
    await expect(deferred.load()).resolves.toBe("recovered");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
