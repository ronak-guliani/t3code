import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./095_ProjectionThreadValidationRuns.ts";

const withMemoryDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const projectionThreadColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
});

it.effect("adds the validation column during a normal upgrade", () =>
  withMemoryDb(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 94 });
      yield* migration;

      assert.isTrue(
        (yield* projectionThreadColumns).some(({ name }) => name === "validation_run_json"),
      );
    }),
  ),
);

it.effect("repairs a missing prerequisite table from a divergent ledger", () =>
  withMemoryDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 94 });
      yield* sql`DROP TABLE projection_threads`;

      yield* migration;

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_threads'
      `;
      assert.deepStrictEqual(tables, [{ name: "projection_threads" }]);
      assert.isTrue(
        (yield* projectionThreadColumns).some(({ name }) => name === "validation_run_json"),
      );
    }),
  ),
);

it.effect("is idempotent when the validation column already exists", () =>
  withMemoryDb(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 94 });
      yield* migration;
      yield* migration;

      const columns = yield* projectionThreadColumns;
      assert.strictEqual(columns.filter(({ name }) => name === "validation_run_json").length, 1);
    }),
  ),
);
