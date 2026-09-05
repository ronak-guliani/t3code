import { EnvironmentId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { clearMobileEnvironmentOwnedData } from "./environment-owned-data-cleanup";

vi.mock("../state/thread-outbox-removal", () => ({
  clearThreadOutboxEnvironment: vi.fn(async () => undefined),
}));
vi.mock("../state/use-composer-drafts", () => ({
  clearComposerDraftsEnvironment: vi.fn(async () => undefined),
}));

describe("clearMobileEnvironmentOwnedData", () => {
  it("clears both queued messages and composer drafts for a removed environment", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    const clearThreadOutbox = vi.fn(async () => undefined);
    const clearComposerDrafts = vi.fn(async () => undefined);
    await Effect.runPromise(
      clearMobileEnvironmentOwnedData(environmentId, { clearThreadOutbox, clearComposerDrafts }),
    );
    expect(clearThreadOutbox).toHaveBeenCalledWith(environmentId);
    expect(clearComposerDrafts).toHaveBeenCalledWith(environmentId);
  });

  it.each(["thread-outbox", "composer-drafts"] as const)(
    "reports a typed %s rejection and still attempts the other resource",
    async (resource) => {
      const environmentId = EnvironmentId.make("environment-1");
      const clearThreadOutbox = vi.fn(async () => {
        if (resource === "thread-outbox") throw new Error("outbox unavailable");
      });
      const clearComposerDrafts = vi.fn(async () => {
        if (resource === "composer-drafts") throw new Error("drafts unavailable");
      });
      const error = await Effect.runPromise(
        clearMobileEnvironmentOwnedData(environmentId, {
          clearThreadOutbox,
          clearComposerDrafts,
        }).pipe(Effect.flip),
      );
      expect(error._tag).toBe("EnvironmentOwnedDataCleanupError");
      expect(error.environmentId).toBe(environmentId);
      expect(error.failures.map((failure) => failure.resource)).toEqual([resource]);
      expect(clearThreadOutbox).toHaveBeenCalledOnce();
      expect(clearComposerDrafts).toHaveBeenCalledOnce();
    },
  );

  it("reports both simultaneous failures and retries both resources", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    let shouldFail = true;
    const clearThreadOutbox = vi.fn(async () => {
      if (shouldFail) throw new Error("outbox unavailable");
    });
    const clearComposerDrafts = vi.fn(async () => {
      if (shouldFail) throw new Error("drafts unavailable");
    });
    const cleanup = clearMobileEnvironmentOwnedData(environmentId, {
      clearThreadOutbox,
      clearComposerDrafts,
    });
    const error = await Effect.runPromise(cleanup.pipe(Effect.flip));
    expect(error.failures.map((failure) => failure.resource)).toEqual([
      "thread-outbox",
      "composer-drafts",
    ]);
    shouldFail = false;
    await Effect.runPromise(cleanup);
    expect(clearThreadOutbox).toHaveBeenCalledTimes(2);
    expect(clearComposerDrafts).toHaveBeenCalledTimes(2);
  });

  it("makes partial completion explicit and recovers on retry", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    let draftAttempts = 0;
    const clearThreadOutbox = vi.fn(async () => undefined);
    const clearComposerDrafts = vi.fn(async () => {
      draftAttempts += 1;
      if (draftAttempts === 1) throw new Error("draft write failed");
    });
    const cleanup = clearMobileEnvironmentOwnedData(environmentId, {
      clearThreadOutbox,
      clearComposerDrafts,
    });
    const error = await Effect.runPromise(cleanup.pipe(Effect.flip));
    expect(error.failures.map((failure) => failure.resource)).toEqual(["composer-drafts"]);
    await Effect.runPromise(cleanup);
    expect(clearThreadOutbox).toHaveBeenCalledTimes(2);
    expect(clearComposerDrafts).toHaveBeenCalledTimes(2);
  });
});
