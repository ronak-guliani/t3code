import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./088_ProjectionProjectKind.ts";

it.layer(NodeSqliteClient.layerMemory())("project kind migration", (it) => {
  it.effect("adds a durable workspace default and preserves imported projects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migration;
      yield* sql`
        INSERT INTO projection_projects
          (project_id, kind, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES
          ('workspace', 'workspace', 'Workspace', '/workspace', '[]', '1970-01-01', '1970-01-01'),
          ('import', 'chat-import', 'Import', '/import', '[]', '1970-01-01', '1970-01-01')
      `;
      yield* migration;
      const rows = yield* sql<{ project_id: string; kind: string }>`
        SELECT project_id, kind FROM projection_projects ORDER BY project_id
      `;
      assert.deepStrictEqual(rows, [
        { project_id: "import", kind: "chat-import" },
        { project_id: "workspace", kind: "workspace" },
      ]);
    }),
  );
});
