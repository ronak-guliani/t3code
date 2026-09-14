import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { threadPullRequestIdentity } from "@t3tools/shared/threadPullRequests";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionThreadPullRequest,
  ProjectionThreadPullRequestDbRow,
  ProjectionThreadPullRequestRepository,
  type ProjectionThreadPullRequest as ProjectionRow,
} from "../Services/ProjectionThreadPullRequests.ts";

const keyOf = (pullRequest: ProjectionRow["pullRequest"]) => {
  const identity = threadPullRequestIdentity(pullRequest);
  return identity;
};

const ProjectionThreadPullRequestDbResult = Schema.Struct({
  threadId: ProjectionThreadPullRequestDbRow.fields.threadId,
  pullRequest: ProjectionThreadPullRequestDbRow.fields.pullRequest,
  source: ProjectionThreadPullRequestDbRow.fields.source,
  linkedAt: ProjectionThreadPullRequestDbRow.fields.linkedAt,
});

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: Schema.Struct({
      row: ProjectionThreadPullRequest,
      host: Schema.String,
      repository: Schema.String,
      number: Schema.Number,
    }),
    execute: ({ row, host, repository, number }) => sql`
      INSERT INTO projection_thread_pull_requests (
        thread_id, host, repository, number, pull_request_json, source, linked_at
      ) VALUES (
        ${row.threadId}, ${host}, ${repository}, ${number},
        ${JSON.stringify(row.pullRequest)}, ${row.source}, ${row.linkedAt}
      )
      ON CONFLICT (thread_id, host, repository, number)
      DO UPDATE SET
        pull_request_json = excluded.pull_request_json,
        source = excluded.source,
        linked_at = excluded.linked_at
    `,
  });

  const listByThread = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: ProjectionThreadPullRequestDbResult,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        pull_request_json AS "pullRequest",
        source,
        linked_at AS "linkedAt"
      FROM projection_thread_pull_requests
      WHERE thread_id = ${threadId}
      ORDER BY linked_at ASC, rowid ASC
    `,
  });

  const listByPullRequest = SqlSchema.findAll({
    Request: Schema.Struct({
      host: Schema.String,
      repository: Schema.String,
      number: Schema.Number,
    }),
    Result: ProjectionThreadPullRequestDbResult,
    execute: ({ host, repository, number }) => sql`
      SELECT
        thread_id AS "threadId",
        pull_request_json AS "pullRequest",
        source,
        linked_at AS "linkedAt"
      FROM projection_thread_pull_requests
      WHERE host = ${host} AND repository = ${repository} AND number = ${number}
      ORDER BY linked_at ASC, thread_id ASC
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: Schema.Struct({
      threadId: Schema.String,
      host: Schema.String,
      repository: Schema.String,
      number: Schema.Number,
    }),
    execute: ({ threadId, host, repository, number }) => sql`
      DELETE FROM projection_thread_pull_requests
      WHERE thread_id = ${threadId} AND host = ${host} AND repository = ${repository} AND number = ${number}
    `,
  });

  const deleteRows = SqlSchema.void({
    Request: Schema.Struct({ threadId: Schema.String }),
    execute: ({ threadId }) =>
      sql`DELETE FROM projection_thread_pull_requests WHERE thread_id = ${threadId}`,
  });

  return {
    upsert: (row: ProjectionRow) => {
      const key = keyOf(row.pullRequest);
      return upsertRow({ row, ...key }).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadPullRequestRepository.upsert")),
      );
    },
    listByThreadId: ({ threadId }: { readonly threadId: string }) =>
      listByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPullRequestRepository.listByThreadId"),
        ),
      ),
    listByPullRequest: ({
      pullRequest,
    }: {
      readonly pullRequest: ProjectionRow["pullRequest"];
    }) => {
      const key = keyOf(pullRequest);
      return listByPullRequest(key).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPullRequestRepository.listByPullRequest"),
        ),
      );
    },
    delete: ({
      threadId,
      pullRequest,
    }: {
      readonly threadId: string;
      readonly pullRequest: ProjectionRow["pullRequest"];
    }) => {
      const key = keyOf(pullRequest);
      return deleteRow({ threadId, ...key }).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadPullRequestRepository.delete")),
      );
    },
    deleteByThreadId: ({ threadId }: { readonly threadId: string }) =>
      deleteRows({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadPullRequestRepository.deleteByThreadId"),
        ),
      ),
  };
});

export const ProjectionThreadPullRequestRepositoryLive = Layer.effect(
  ProjectionThreadPullRequestRepository,
  makeRepository,
);
