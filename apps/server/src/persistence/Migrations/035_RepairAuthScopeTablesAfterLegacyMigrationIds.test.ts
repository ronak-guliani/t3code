import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_RepairAuthScopeTablesAfterLegacyMigrationIds", (it) => {
  it.effect(
    "repairs role-based auth tables when a legacy migration ledger is already past 32",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 22 });
        yield* Effect.forEach(
          [23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34],
          (migrationId) =>
            sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${migrationId}, ${`LegacyMigration${migrationId}`})
        `,
        );

        yield* sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          role,
          subject,
          created_at,
          expires_at
        )
        VALUES (
          'link-owner',
          'bootstrap-owner',
          'desktop-bootstrap',
          'owner',
          'desktop',
          '2026-05-29T00:00:00.000Z',
          '2026-05-29T01:00:00.000Z'
        )
      `;
        yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          role,
          method,
          issued_at,
          expires_at
        )
        VALUES (
          'session-owner',
          'desktop',
          'owner',
          'browser-session-cookie',
          '2026-05-29T00:00:00.000Z',
          '2026-05-29T01:00:00.000Z'
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 35 });

        const pairingColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
        const sessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
        const pairingRows = yield* sql<{ readonly id: string }>`
        SELECT id FROM auth_pairing_links
      `;
        const sessionRows = yield* sql<{ readonly sessionId: string }>`
        SELECT session_id AS "sessionId" FROM auth_sessions
      `;
        const migrationRows = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id = 35
      `;

        assert.isTrue(pairingColumns.some((column) => column.name === "scopes"));
        assert.isTrue(pairingColumns.some((column) => column.name === "proof_key_thumbprint"));
        assert.isFalse(pairingColumns.some((column) => column.name === "role"));
        assert.isTrue(sessionColumns.some((column) => column.name === "scopes"));
        assert.isTrue(sessionColumns.some((column) => column.name === "client_device_type"));
        assert.isTrue(sessionColumns.some((column) => column.name === "last_connected_at"));
        assert.isFalse(sessionColumns.some((column) => column.name === "role"));
        assert.deepStrictEqual(pairingRows, []);
        assert.deepStrictEqual(sessionRows, []);
        assert.deepStrictEqual(migrationRows, [
          {
            migrationId: 35,
            name: "RepairAuthScopeTablesAfterLegacyMigrationIds",
          },
        ]);
      }),
  );
});
