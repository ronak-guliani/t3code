import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ThreadNudging from "./086_ThreadNudging.ts";

it.layer(NodeSqliteClient.layerMemory())("ThreadNudging migration", (it) => {
  it.effect("adds default-off state idempotently and repairs a missing prerequisite table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 85 });
      yield* ThreadNudging;
      yield* ThreadNudging;
      const columns = yield* sql<{
        name: string;
        dflt_value: string;
      }>`PRAGMA table_info(projection_threads)`;
      assert.strictEqual(
        columns.find((column) => column.name === "nudging_json")?.dflt_value,
        "'{}'",
      );
      yield* sql`DROP TABLE projection_threads`;
      yield* ThreadNudging;
      const repaired = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isTrue(repaired.some((column) => column.name === "nudging_json"));
    }),
  );
});
