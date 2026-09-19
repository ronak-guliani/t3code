import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./098_ProjectionThreadCollaborationRequests.ts";

const memory = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect("repairs a divergent projection ledger before adding the column", () =>
  memory(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 97 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE projection_threads`;

      yield* migration;

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(columns.some(({ name }) => name === "collaboration_requests_json"));
    }),
  ),
);

it.effect("is idempotent", () =>
  memory(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 97 });
      yield* migration;
      yield* migration;

      const rows = yield* SqlClient.SqlClient.pipe(
        Effect.flatMap(
          (sql) =>
            sql<{ readonly name: string }>`
              SELECT name FROM pragma_table_info('projection_threads')
              WHERE name = 'collaboration_requests_json'
            `,
        ),
      );
      assert.deepStrictEqual(rows, [{ name: "collaboration_requests_json" }]);
    }),
  ),
);
