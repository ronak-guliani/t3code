import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./083_ProjectionProjectsAutoPull.ts";

it.layer(NodeSqliteClient.layerMemory())("project auto-pull migration", (it) => {
  it.effect("creates the prerequisite and preserves an enabled value when replayed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migration;
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
      assert.isTrue(columns.some((column) => column.name === "default_model_selection_json"));
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project', 'Project', '/project', '[]', '1970-01-01', '1970-01-01')
      `;
      const before = yield* sql<{ auto_pull: number }>`SELECT auto_pull FROM projection_projects`;
      assert.equal(before[0]?.auto_pull, 0);
      yield* sql`UPDATE projection_projects SET auto_pull = 1`;
      yield* migration;
      const after = yield* sql<{ auto_pull: number }>`SELECT auto_pull FROM projection_projects`;
      assert.equal(after[0]?.auto_pull, 1);
    }),
  );
});
