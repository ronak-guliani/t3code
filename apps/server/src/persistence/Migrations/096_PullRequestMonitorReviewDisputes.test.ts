import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./096_PullRequestMonitorReviewDisputes.ts";

const withMemoryDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const columns = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.unsafe(table)})`;
  });

it.effect("adds durable dispute metadata during a normal upgrade", () =>
  withMemoryDb(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 95 });
      yield* migration;

      const itemNames = (yield* columns("pull_request_monitor_feedback_items")).map(
        ({ name }) => name,
      );
      const reportNames = (yield* columns("pull_request_monitor_feedback_reports")).map(
        ({ name }) => name,
      );
      assert.includeMembers(itemNames, [
        "origin",
        "origin_thread_id",
        "child_disposition",
        "reviewer_disposition",
      ]);
      assert.include(reportNames, "actor_role");
    }),
  ),
);

it.effect("repairs a divergent monitor ledger and remains idempotent", () =>
  withMemoryDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      yield* migration;
      yield* migration;

      const itemNames = (yield* columns("pull_request_monitor_feedback_items")).map(
        ({ name }) => name,
      );
      const reportNames = (yield* columns("pull_request_monitor_feedback_reports")).map(
        ({ name }) => name,
      );
      assert.strictEqual(itemNames.filter((name) => name === "origin").length, 1);
      assert.strictEqual(reportNames.filter((name) => name === "actor_role").length, 1);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'pull_request_monitor_feedback_items',
          'pull_request_monitor_feedback_reports'
        )
        ORDER BY name
      `;
      assert.deepStrictEqual(tables, [
        { name: "pull_request_monitor_feedback_items" },
        { name: "pull_request_monitor_feedback_reports" },
      ]);
    }),
  ),
);
