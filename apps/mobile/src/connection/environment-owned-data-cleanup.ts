import type { EnvironmentId } from "@t3tools/contracts";
import { Effect } from "effect";

import { clearThreadOutboxEnvironment } from "../state/thread-outbox";
import { clearComposerDraftsEnvironment } from "../state/use-composer-drafts";

export function clearMobileEnvironmentOwnedData(
  environmentId: EnvironmentId,
  operations: {
    readonly clearThreadOutbox: (id: EnvironmentId) => Promise<void>;
    readonly clearComposerDrafts: (id: EnvironmentId) => Promise<void>;
  } = {
    clearThreadOutbox: clearThreadOutboxEnvironment,
    clearComposerDrafts: clearComposerDraftsEnvironment,
  },
) {
  return Effect.all(
    [
      Effect.promise(() => operations.clearThreadOutbox(environmentId)),
      Effect.promise(() => operations.clearComposerDrafts(environmentId)),
    ],
    { concurrency: "unbounded", discard: true },
  );
}
