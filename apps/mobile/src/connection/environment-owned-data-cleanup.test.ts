import { EnvironmentId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { clearMobileEnvironmentOwnedData } from "./environment-owned-data-cleanup";

describe("clearMobileEnvironmentOwnedData", () => {
  it("reports typed failures after attempting every resource", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    const clearThreadOutbox = vi.fn(async () => {
      throw new Error("outbox unavailable");
    });
    const clearComposerDrafts = vi.fn(async () => undefined);

    const error = await Effect.runPromise(
      clearMobileEnvironmentOwnedData(environmentId, {
        clearThreadOutbox,
        clearComposerDrafts,
      }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      _tag: "EnvironmentOwnedDataCleanupError",
      environmentId,
    });
    expect(error.failures.map((failure) => failure.resource)).toEqual(["thread-outbox"]);
    expect(clearThreadOutbox).toHaveBeenCalledOnce();
    expect(clearComposerDrafts).toHaveBeenCalledOnce();
  });
});
