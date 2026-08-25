import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionReconciliationJob,
  ProjectionReconciliationJobRepository,
  type ProjectionReconciliationJobRepositoryShape,
} from "../Services/ProjectionReconciliationJobs.ts";

const ProjectionReconciliationJobDbRow = ProjectionReconciliationJob.mapFields(
  Struct.assign({
    shellThreadIds: Schema.fromJsonString(ProjectionReconciliationJob.fields.shellThreadIds),
    attachmentThreadIds: Schema.fromJsonString(
      ProjectionReconciliationJob.fields.attachmentThreadIds,
    ),
  }),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const enqueueRow = SqlSchema.void({
    Request: ProjectionReconciliationJob,
    execute: (job) => sql`
      INSERT INTO projection_reconciliation_jobs (
        sequence,
        shell_thread_ids_json,
        attachment_thread_ids_json,
        created_at
      )
      VALUES (
        ${job.sequence},
        ${JSON.stringify(job.shellThreadIds)},
        ${JSON.stringify(job.attachmentThreadIds)},
        ${job.createdAt}
      )
      ON CONFLICT (sequence)
      DO UPDATE SET
        shell_thread_ids_json = excluded.shell_thread_ids_json,
        attachment_thread_ids_json = excluded.attachment_thread_ids_json,
        created_at = excluded.created_at
    `,
  });

  const listPendingRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionReconciliationJobDbRow,
    execute: () => sql`
      SELECT
        sequence,
        shell_thread_ids_json AS "shellThreadIds",
        attachment_thread_ids_json AS "attachmentThreadIds",
        created_at AS "createdAt"
      FROM projection_reconciliation_jobs
      ORDER BY sequence ASC
    `,
  });

  const completeRows = SqlSchema.void({
    Request: Schema.Struct({
      sequence: Schema.Finite,
    }),
    execute: ({ sequence }) => sql`
      DELETE FROM projection_reconciliation_jobs
      WHERE sequence <= ${sequence}
    `,
  });

  return {
    enqueue: (job) =>
      enqueueRow(job).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionReconciliationJobRepository.enqueue:query"),
        ),
      ),
    listPending: () =>
      listPendingRows(undefined).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            ...row,
            shellThreadIds: [...row.shellThreadIds],
            attachmentThreadIds: [...row.attachmentThreadIds],
          })),
        ),
        Effect.mapError(
          toPersistenceSqlError("ProjectionReconciliationJobRepository.listPending:query"),
        ),
      ),
    completeThrough: (input) =>
      completeRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionReconciliationJobRepository.completeThrough:query"),
        ),
      ),
  } satisfies ProjectionReconciliationJobRepositoryShape;
});

export const ProjectionReconciliationJobRepositoryLive = Layer.effect(
  ProjectionReconciliationJobRepository,
  make,
);
