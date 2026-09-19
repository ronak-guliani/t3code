import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import PullRequestMonitorFeedback from "./072_PullRequestMonitorFeedback.ts";
import PullRequestMonitorRevisionIdentity from "./076_PullRequestMonitorRevisionIdentity.ts";

/**
 * Adds reviewer/child dispute state to the existing finding ledger. The guarded prerequisite
 * migrations make this safe for databases whose historical migration ledger skipped 071-076.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* PullRequestMonitorFeedback;
  yield* PullRequestMonitorRevisionIdentity;

  const itemColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(pull_request_monitor_feedback_items)
  `;
  if (!itemColumns.some((column) => column.name === "origin")) {
    yield* sql`
      ALTER TABLE pull_request_monitor_feedback_items
      ADD COLUMN origin TEXT NOT NULL DEFAULT 'provider'
    `;
  }
  if (!itemColumns.some((column) => column.name === "origin_thread_id")) {
    yield* sql`
      ALTER TABLE pull_request_monitor_feedback_items
      ADD COLUMN origin_thread_id TEXT
    `;
  }
  if (!itemColumns.some((column) => column.name === "child_disposition")) {
    yield* sql`
      ALTER TABLE pull_request_monitor_feedback_items
      ADD COLUMN child_disposition TEXT
    `;
  }
  if (!itemColumns.some((column) => column.name === "reviewer_disposition")) {
    yield* sql`
      ALTER TABLE pull_request_monitor_feedback_items
      ADD COLUMN reviewer_disposition TEXT
    `;
  }

  const reportColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(pull_request_monitor_feedback_reports)
  `;
  if (!reportColumns.some((column) => column.name === "actor_role")) {
    yield* sql`
      ALTER TABLE pull_request_monitor_feedback_reports
      ADD COLUMN actor_role TEXT NOT NULL DEFAULT 'provider'
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_monitor_feedback_items_origin
    ON pull_request_monitor_feedback_items(monitor_id, origin, origin_thread_id)
  `;
});
