import { Effect, FileSystem, Layer, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig, type ServerConfigShape } from "./config.ts";
import { makeRuntimeSqliteLayer } from "./persistence/Layers/Sqlite.ts";
import { inspectPersistedServerRuntimeState, runtimePidIsAlive } from "./serverRuntimeState.ts";

export const makeServerStartupClaim = (
  config: Pick<ServerConfigShape, "stateDir" | "serverRuntimeStatePath">,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      return Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const connection = yield* sql.reserve;
          yield* connection.executeRaw("PRAGMA busy_timeout = 0", []);
          // A dedicated, never-unlinked SQLite file gives all launchers an OS-backed lifetime
          // claim. A crashed process releases its lock without stale-file deletion races.
          yield* Effect.acquireRelease(
            connection
              .executeRaw("BEGIN EXCLUSIVE", [])
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new Error(
                      `Cannot claim ${config.stateDir}: another server is starting/running, or the directory cannot be locked. No server was started.`,
                      { cause },
                    ),
                ),
              ),
            () =>
              connection.executeRaw("ROLLBACK", []).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Failed to release server startup claim", {
                    cause,
                    stateDir: config.stateDir,
                  }),
                ),
              ),
          );
          const runtime = yield* inspectPersistedServerRuntimeState(config.serverRuntimeStatePath);
          if (runtime._tag === "Invalid") {
            return yield* Effect.fail(
              new Error("Cannot verify existing server runtime state. No server was started.", {
                cause: runtime.cause,
              }),
            );
          }
          if (runtime._tag === "Found" && runtimePidIsAlive(runtime.state.pid)) {
            return yield* Effect.fail(
              new Error(
                `Environment is already served by PID ${runtime.state.pid}. Attach to that server instead; no second server was started.`,
              ),
            );
          }
        }),
      ).pipe(
        Layer.provide(
          makeRuntimeSqliteLayer({
            filename: path.join(config.stateDir, "server-startup.sqlite"),
            disableWAL: true,
          }),
        ),
      );
    }),
  );

export const ServerStartupClaimLive = Layer.unwrap(
  Effect.map(ServerConfig, makeServerStartupClaim),
);
