import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import EnsureAuthSessionScopes from "./064_AuthSessionScopes.ts";
import EnsureAuthPairingLinkScopes from "./065_AuthPairingLinkScopes.ts";

const hasColumn = (columns: ReadonlyArray<{ readonly name: string }>, name: string) =>
  columns.some((column) => column.name === name);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* EnsureAuthSessionScopes;
  yield* EnsureAuthPairingLinkScopes;
  const pairingLinkColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;
  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;

  if (!hasColumn(pairingLinkColumns, "proof_key_thumbprint")) {
    yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN proof_key_thumbprint TEXT`;
  }
  if (!hasColumn(sessionColumns, "proof_key_thumbprint")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN proof_key_thumbprint TEXT`;
  }
});
