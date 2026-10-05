/** Attachments and terminals are measured only; history and live processes are never reset here. */
import { Effect } from "effect";

import { ServerConfig } from "../../config.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { measureDirectory } from "../measureDirectory.ts";
import type { StorageCleanupContributor } from "../StorageCleanup.ts";

export const makeRuntimeFilesStorageContributor = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const terminalManager = yield* TerminalManager;

  const measure: StorageCleanupContributor["measure"] = ({ signal, report }) =>
    Effect.gen(function* () {
      let running = 0;
      let subprocesses = 0;
      const unsubscribe = yield* terminalManager.subscribeMetadata((event) =>
        Effect.sync(() => {
          if (event.type !== "snapshot") return;
          const live = event.terminals.filter((terminal) => terminal.status === "running");
          running = live.length;
          subprocesses = live.filter((terminal) => terminal.hasRunningSubprocess).length;
        }),
      );
      unsubscribe();
      yield* report({
        category: "terminals",
        status: "complete",
        bytes: 0,
        items: running,
        detail: `${subprocesses} running a subprocess`,
      });
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
    categories: ["attachments", "terminals"],
    measure,
    plan: () => Effect.succeed([]),
    execute: () => Effect.succeed([]),
  } satisfies StorageCleanupContributor;
});
