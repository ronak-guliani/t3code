/**
 * OrchestrationProjectionPipeline - Event projection pipeline service interface.
 *
 * Coordinates projection bootstrap/replay and per-event projection updates for
 * orchestration read models.
 *
 * @module OrchestrationProjectionPipeline
 */
import type { OrchestrationEvent } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";
import type * as PlatformError from "effect/PlatformError";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

/**
 * OrchestrationProjectionPipelineShape - Service API for projection execution.
 */
export interface OrchestrationProjectionPipelineShape {
  /**
   * Bootstrap projections by replaying persisted events.
   *
   * Resumes each projector from its stored projection-state cursor.
   */
  readonly bootstrap: Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Project a single orchestration event into projection repositories.
   *
   * Projectors are executed sequentially to preserve deterministic ordering.
   */
  readonly projectEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<ProjectionReceipt, ProjectionRepositoryError>;
}

export interface ProjectionReceipt {
  /**
   * Run durable work that must observe committed projection rows.
   *
   * Callers that stage projection inside a larger transaction invoke this only
   * after that transaction commits.
   */
  readonly reconcile: Effect.Effect<void, ProjectionRepositoryError | PlatformError.PlatformError>;
}

/**
 * OrchestrationProjectionPipeline - Service tag for orchestration projections.
 */
export class OrchestrationProjectionPipeline extends Context.Service<
  OrchestrationProjectionPipeline,
  OrchestrationProjectionPipelineShape
>()("t3/orchestration/Services/ProjectionPipeline/OrchestrationProjectionPipeline") {}
