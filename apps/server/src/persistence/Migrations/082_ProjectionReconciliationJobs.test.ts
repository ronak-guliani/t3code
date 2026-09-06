import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("082_ProjectionReconciliationJobs", (it) => {
  it.effect("creates the durable pending-job ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 82 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(projection_reconciliation_jobs)`;
      assert.deepEqual(
        columns.map(({ name, notnull, pk }) => ({ name, notnull, pk })),
        [
          { name: "sequence", notnull: 0, pk: 1 },
          { name: "shell_thread_ids_json", notnull: 1, pk: 0 },
          { name: "attachment_thread_ids_json", notnull: 1, pk: 0 },
          { name: "created_at", notnull: 1, pk: 0 },
        ],
      );
    }),
  );
});
