import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import ChildLifecycleNotifications from "./080_ChildLifecycleNotifications.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_threads'`;
  if (tables.length === 0) yield* ChildLifecycleNotifications;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some(({ name }) => name === "nudging_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN nudging_json TEXT NOT NULL DEFAULT '{}'`;
  }
});
