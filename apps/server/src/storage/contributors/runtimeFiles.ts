/** Attachments are measured only: they belong to chat history. */
import { Effect } from "effect";

import { ServerConfig } from "../../config.ts";
import { measureDirectory } from "../measureDirectory.ts";
import type { StorageCleanupContributor } from "../StorageCleanup.ts";

export const makeRuntimeFilesStorageContributor = Effect.gen(function* () {
  const config = yield* ServerConfig;

  const measure: StorageCleanupContributor["measure"] = ({ signal, report }) =>
    Effect.gen(function* () {
      const attachments = yield* Effect.promise(() =>
        measureDirectory(config.attachmentsDir, { signal }),
      );
      yield* report({
        category: "attachments",
        status: "complete",
        bytes: attachments.bytes,
        items: attachments.files,
      });
    });

  return {
    id: "runtime-files",
    categories: ["attachments"],
    measure,
    plan: () => Effect.succeed([]),
    execute: () => Effect.succeed([]),
  } satisfies StorageCleanupContributor;
});
