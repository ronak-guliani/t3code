import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { TurnId } from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadProposedPlansByTurnIdsInput,
  DeleteProjectionThreadProposedPlansInput,
  ListProjectionThreadProposedPlansInput,
  ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanSummary,
  ProjectionThreadProposedPlanRepository,
  type ProjectionThreadProposedPlanRepositoryShape,
} from "../Services/ProjectionThreadProposedPlans.ts";

const makeProjectionThreadProposedPlanRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadProposedPlanRow = SqlSchema.void({
    Request: ProjectionThreadProposedPlan,
    execute: (row) => sql`
      INSERT INTO projection_thread_proposed_plans (
        plan_id,
        thread_id,
        turn_id,
        plan_markdown,
        implemented_at,
        implementation_thread_id,
        created_at,
        updated_at
      )
      VALUES (
        ${row.planId},
        ${row.threadId},
        ${row.turnId},
        ${row.planMarkdown},
        ${row.implementedAt},
        ${row.implementationThreadId},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (plan_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        plan_markdown = excluded.plan_markdown,
        implemented_at = excluded.implemented_at,
        implementation_thread_id = excluded.implementation_thread_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listProjectionThreadProposedPlanRows = SqlSchema.findAll({
    Request: ListProjectionThreadProposedPlansInput,
    Result: ProjectionThreadProposedPlan,
    execute: ({ threadId }) => sql`
      SELECT
        plan_id AS "planId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        plan_markdown AS "planMarkdown",
        implemented_at AS "implementedAt",
        implementation_thread_id AS "implementationThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, plan_id ASC
    `,
  });

  const listProjectionThreadProposedPlanSummaryRows = SqlSchema.findAll({
    Request: ListProjectionThreadProposedPlansInput,
    Result: ProjectionThreadProposedPlanSummary,
    execute: ({ threadId }) => sql`
      SELECT
        plan_id AS "planId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        implemented_at AS "implementedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, plan_id ASC
    `,
  });

  const deleteProjectionThreadProposedPlanRows = SqlSchema.void({
    Request: DeleteProjectionThreadProposedPlansInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
    `,
  });

  const deleteProjectionThreadProposedPlanRowsByTurnIds = SqlSchema.void({
    Request: DeleteProjectionThreadProposedPlansByTurnIdsInput,
    execute: ({ threadId, turnIds }) =>
      turnIds.length === 0
        ? sql`DELETE FROM projection_thread_proposed_plans WHERE 1 = 0`
        : sql`
          DELETE FROM projection_thread_proposed_plans
          WHERE thread_id = ${threadId}
            AND turn_id IN ${sql.in(turnIds)}
        `,
  });

  const listProjectionThreadProposedPlanTurnIds = SqlSchema.findAll({
    Request: ListProjectionThreadProposedPlansInput,
    Result: Schema.Struct({ turnId: TurnId }),
    execute: ({ threadId }) =>
      sql`
        SELECT DISTINCT turn_id AS "turnId"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
          AND turn_id IS NOT NULL
        ORDER BY turn_id ASC
      `,
  });

  const upsert: ProjectionThreadProposedPlanRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadProposedPlanRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadProposedPlanRepository.upsert:query")),
    );

  const listByThreadId: ProjectionThreadProposedPlanRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadProposedPlanRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.listByThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadProposedPlanRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteProjectionThreadProposedPlanRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.deleteByThreadId:query"),
      ),
    );

  const deleteByTurnIds: ProjectionThreadProposedPlanRepositoryShape["deleteByTurnIds"] = (input) =>
    deleteProjectionThreadProposedPlanRowsByTurnIds(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.deleteByTurnIds:query"),
      ),
    );

  const listTurnIdsByThreadId: ProjectionThreadProposedPlanRepositoryShape["listTurnIdsByThreadId"] =
    (input) =>
      listProjectionThreadProposedPlanTurnIds(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadProposedPlanRepository.listTurnIdsByThreadId:query",
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.turnId)),
      );

  const listSummariesByThreadId: ProjectionThreadProposedPlanRepositoryShape["listSummariesByThreadId"] =
    (input) =>
      listProjectionThreadProposedPlanSummaryRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadProposedPlanRepository.listSummariesByThreadId:query",
          ),
        ),
      );

  return {
    upsert,
    listByThreadId,
    listTurnIdsByThreadId,
    deleteByThreadId,
    deleteByTurnIds,
    listSummariesByThreadId,
  } satisfies ProjectionThreadProposedPlanRepositoryShape;
});

export const ProjectionThreadProposedPlanRepositoryLive = Layer.effect(
  ProjectionThreadProposedPlanRepository,
  makeProjectionThreadProposedPlanRepository,
);
