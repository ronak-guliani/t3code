import { EnvironmentId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { clearMobileEnvironmentOwnedData } from "./environment-owned-data-cleanup";

describe("clearMobileEnvironmentOwnedData", () => {
  it("clears both queued messages and composer drafts for a removed environment", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    const clearThreadOutbox = vi.fn(async () => undefined);
    const clearComposerDrafts = vi.fn(async () => undefined);

    await Effect.runPromise(
      clearMobileEnvironmentOwnedData(environmentId, {
        clearThreadOutbox,
        clearComposerDrafts,
      }),
    );

    expect(clearThreadOutbox).toHaveBeenCalledWith(environmentId);
    expect(clearComposerDrafts).toHaveBeenCalledWith(environmentId);
  });
});
