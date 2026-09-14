import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { threadPullRequestIdentity } from "@t3tools/shared/threadPullRequests";
import ProjectionThreadsPullRequest from "./066_ProjectionThreadsPullRequest.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* ProjectionThreadsPullRequest;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_pull_requests (
      thread_id TEXT NOT NULL,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      pull_request_json TEXT NOT NULL,
      source TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, host, repository, number)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_pull_requests_identity
    ON projection_thread_pull_requests(host, repository, number, thread_id)
  `;

  const rows = yield* sql<{
    readonly thread_id: string;
    readonly pull_request_json: string;
    readonly updated_at: string;
  }>`
    SELECT thread_id, pull_request_json, updated_at
    FROM projection_threads
    WHERE pull_request_json IS NOT NULL
      AND pull_request_json != 'null'
  `;

  for (const row of rows) {
    let pullRequest: unknown;
    try {
      pullRequest = JSON.parse(row.pull_request_json) as unknown;
    } catch {
      continue;
    }
    const candidate = pullRequest as {
      readonly url?: unknown;
      readonly number?: unknown;
    };
    if (
      typeof pullRequest !== "object" ||
      pullRequest === null ||
      typeof candidate.url !== "string" ||
      candidate.url.trim().length === 0 ||
      typeof candidate.number !== "number" ||
      !Number.isSafeInteger(candidate.number) ||
      candidate.number <= 0
    ) {
      continue;
    }
    const identity = threadPullRequestIdentity({
      url: candidate.url,
      number: candidate.number,
    });
    if (identity.host === "unknown" || identity.repository.length === 0) continue;
    yield* sql`
      INSERT INTO projection_thread_pull_requests (
        thread_id, host, repository, number, pull_request_json, source, linked_at
      ) VALUES (
        ${row.thread_id},
        ${identity.host},
        ${identity.repository},
        ${identity.number},
        ${row.pull_request_json},
        'created',
        ${row.updated_at}
      )
      ON CONFLICT (thread_id, host, repository, number) DO NOTHING
    `;
  }
});
