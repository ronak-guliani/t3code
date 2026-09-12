import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import {
  discoverLocalEnvironments,
  selectLocalEnvironment,
} from "@t3tools/shared/localEnvironment";
import { backupLocalEnvironment, restoreLocalEnvironment } from "./localBackup.ts";

const baseDir = Flag.string("base-dir").pipe(
  Flag.withDescription("Explicit local environment data directory."),
);
const list = Command.make("list").pipe(
  Command.withDescription("Inspect known local environments without changing the default."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const { environments, selectionError } = yield* Effect.tryPromise(() =>
        discoverLocalEnvironments(),
      );
      if (selectionError) yield* Console.error(selectionError);
      yield* Console.log(JSON.stringify(environments, null, 2));
    }),
  ),
);
const select = Command.make("select", { baseDir }).pipe(
  Command.withDescription(
    "Choose the shared local default. Explicit overrides and development launches stay pinned.",
  ),
  Command.withHandler(({ baseDir }) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => selectLocalEnvironment(baseDir));
      yield* Console.log(
        "Default local environment selected. Stop any server using it before restarting the regular desktop app. To keep that server running, use a separate desktop home and add it through Settings > Connections. No history was copied or merged.",
      );
    }),
  ),
);
const backup = Command.make("backup", { baseDir, output: Flag.string("output") }).pipe(
  Command.withDescription(
    "Back up a stopped local environment to a new private directory. Includes credentials; protect the backup.",
  ),
  Command.withHandler(({ baseDir, output }) =>
    Effect.gen(function* () {
      const path = yield* Effect.tryPromise(() => backupLocalEnvironment(baseDir, output));
      yield* Console.log(
        `Verified backup: ${path}\nContains private history and credentials. Do not share or commit it.`,
      );
    }),
  ),
);
const restore = Command.make("restore", {
  baseDir,
  archive: Flag.string("archive"),
  confirm: Flag.boolean("confirm"),
}).pipe(
  Command.withDescription(
    "Recover a verified backup at its original, absent data directory. Never merges or clones a host.",
  ),
  Command.withHandler(({ baseDir, archive, confirm }) =>
    Effect.gen(function* () {
      if (!confirm)
        return yield* Effect.fail(
          new Error(
            "Pass --confirm after stopping the server and preserving the old data directory.",
          ),
        );
      yield* Effect.tryPromise(() => restoreLocalEnvironment(archive, baseDir));
      yield* Console.log(
        "Environment recovered. Keep the old copy stopped; do not run two copies of the same environment identity.",
      );
    }),
  ),
);
export const localCommand = Command.make("local").pipe(
  Command.withDescription(
    "Discover, select, and safely back up local environments. These operations never follow a remote CLI target.",
  ),
  Command.withSubcommands([list, select, backup, restore]),
);
