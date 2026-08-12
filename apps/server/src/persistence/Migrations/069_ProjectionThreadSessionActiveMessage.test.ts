import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "069_ProjectionThreadSessionActiveMessage",
  (it) => {
    it.effect("adds the active message column idempotently", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 68 });
        yield* runMigrations({ toMigrationInclusive: 69 });
        yield* runMigrations({ toMigrationInclusive: 69 });

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_thread_sessions)
        `;
        assert.isTrue(columns.some((column) => column.name === "active_message_id"));
      }),
    );
  },
);
