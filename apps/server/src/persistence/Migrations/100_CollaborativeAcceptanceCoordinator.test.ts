import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("adds durable exchange provenance columns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 99 });
    yield* runMigrations({ toMigrationInclusive: 100 });

    const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(collaborative_acceptance_exchanges)
    `;
    const names = new Set(columns.map(({ name }) => name));
    for (const name of ["candidate_id", "head_sha", "request_id", "review_mode"]) {
      assert.isTrue(names.has(name), `missing exchange provenance column ${name}`);
    }

    const indexes = yield* sql<{ readonly name: string }>`
      PRAGMA index_list(collaborative_acceptance_exchanges)
    `;
    assert.isTrue(
      indexes.some(({ name }) => name === "idx_collaborative_acceptance_exchanges_candidate"),
    );

    yield* runMigrations({ toMigrationInclusive: 101 });
    const caseColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(collaborative_acceptance_cases)
    `;
    const caseNames = new Set(caseColumns.map(({ name }) => name));
    assert.isTrue(caseNames.has("provider_evidence_json"));
    assert.isTrue(caseNames.has("obligations_json"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
