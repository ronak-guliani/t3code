import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionThreadsPendingRuntimeMode from "./027_ProjectionThreadsPendingRuntimeMode.ts";
import ProjectionTurnScopedFiles from "./028_ProjectionTurnScopedFiles.ts";
import EnsureProviderInstanceIdColumns from "./032_EnsureProviderInstanceIdColumns.ts";
import ProjectionThreadParentThreadId from "./034_ProjectionThreadParentThreadId.ts";

/**
 * Divergent branch ledgers can record IDs 29-34 under unrelated names (or jump
 * the high-water mark past them), so the canonical migrations that add:
 *   - projection_thread_sessions.resume_cursor_json
 *   - projection_threads.pending_runtime_mode
 *   - projection_turns checkpoint turn-file columns
 *   - provider_instance_id on sessions/runtime
 *   - projection_threads.parent_thread_id
 * never execute. Shell/thread snapshot queries then fail with "no such column"
 * after later migrations (including the 056 queued-turns repair) succeed.
 *
 * Re-apply those steps idempotently so CLI/server startup can project again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "resume_cursor_json")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN resume_cursor_json TEXT
    `;
  }

  // 032 also ensures pending_runtime_mode; keep the dedicated step first so a
  // partial 032 failure cannot leave threads without it.
  yield* ProjectionThreadsPendingRuntimeMode;
  yield* ProjectionTurnScopedFiles;
  yield* EnsureProviderInstanceIdColumns;
  yield* ProjectionThreadParentThreadId;
});
