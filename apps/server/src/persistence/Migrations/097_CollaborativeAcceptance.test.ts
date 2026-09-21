import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./097_CollaborativeAcceptance.ts";

const withMemoryDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect("creates the acceptance aggregate and its provenance tables", () =>
  withMemoryDb(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 95 });
      yield* migration;

      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'collaborative_acceptance_%'
        ORDER BY name
      `;

      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        [
          "collaborative_acceptance_assessments",
          "collaborative_acceptance_candidates",
          "collaborative_acceptance_cases",
          "collaborative_acceptance_evidence",
          "collaborative_acceptance_exchanges",
        ],
      );
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(collaborative_acceptance_cases)
      `;
      assert.isTrue(columns.some(({ name }) => name === "revision"));
    }),
  ),
);

it.effect("is idempotent", () =>
  withMemoryDb(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 95 });
      yield* migration;
      yield* migration;

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'collaborative_acceptance_cases'
      `;
      assert.strictEqual(rows.length, 1);
    }),
  ),
);
