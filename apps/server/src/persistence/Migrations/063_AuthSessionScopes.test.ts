import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("063_AuthSessionScopes", (it) => {
  it.effect("adds nullable scopes without invalidating legacy sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          role,
          method,
          client_device_type,
          issued_at,
          expires_at
        ) VALUES (
          'legacy-session',
          'desktop',
          'owner',
          'browser-session-cookie',
          'desktop',
          '2026-08-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 63 });

      const rows = yield* sql<{ readonly sessionId: string; readonly scopes: string | null }>`
        SELECT session_id AS "sessionId", scopes
        FROM auth_sessions
      `;
      assert.deepStrictEqual(rows, [{ sessionId: "legacy-session", scopes: null }]);
    }),
  );
});
