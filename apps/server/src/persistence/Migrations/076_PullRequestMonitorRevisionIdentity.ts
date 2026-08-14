import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import PullRequestMonitorFeedback from "./072_PullRequestMonitorFeedback.ts";
import PullRequestMonitorFallback from "./074_PullRequestMonitorFallback.ts";

/**
 * Source-derived feedback revision identity plus fallback launch staging.
 *
 * A revision is identified by the observed source content, so replaying the same
 * provider observation is a no-op instead of a duplicate wake. Fallback launches
 * record their intent before any worktree/thread side effect, so the stage column
 * must exist for crash recovery to reconcile interrupted launches.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* PullRequestMonitorFeedback;
  yield* PullRequestMonitorFallback;

  const revisionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(pull_request_monitor_feedback_revisions)
  `;
  if (!revisionColumns.some((column) => column.name === "content_hash")) {
    yield* sql`
      ALTER TABLE pull_request_monitor_feedback_revisions
      ADD COLUMN content_hash TEXT
    `;
  }
  yield* sql`
    UPDATE pull_request_monitor_feedback_revisions
    SET content_hash = revision_id
    WHERE content_hash IS NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_monitor_feedback_revisions_identity
    ON pull_request_monitor_feedback_revisions(item_id, source_revision, content_hash)
  `;

  const launchColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(pull_request_monitor_fallback_launches)
  `;
  if (!launchColumns.some((column) => column.name === "updated_at")) {
    yield* sql`
      ALTER TABLE pull_request_monitor_fallback_launches
      ADD COLUMN updated_at TEXT
    `;
  }
  yield* sql`
    UPDATE pull_request_monitor_fallback_launches
    SET updated_at = created_at
    WHERE updated_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_monitor_fallback_status
    ON pull_request_monitor_fallback_launches(status, updated_at)
  `;
});
