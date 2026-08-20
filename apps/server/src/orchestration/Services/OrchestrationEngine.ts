/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `Context.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Effect, Option } from "effect";
import type { Stream } from "effect";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /**
   * Read the compact in-memory model used for metadata lookups and command validation.
   * Test doubles may omit this and fall back to getReadModel through readCommandModel.
   */
  readonly getCommandReadModel?: () => Effect.Effect<OrchestrationReadModel, never, never>;

  /** Read one thread with its message, activity, and checkpoint bodies. */
  readonly getThreadDetailById?: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, never, never>;

  /**
   * Read authoritative metadata with the latest projected bodies for recovery
   * paths that must continue after event persistence outruns SQL projection.
   */
  readonly getRecoveryReadModel?: (
    threadId?: ThreadId,
  ) => Effect.Effect<OrchestrationReadModel, never, never>;

  /**
   * Read the current in-memory orchestration read model.
   *
   * @returns Effect containing the latest read model.
   */
  readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, never, never>;

  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Serialize worktree binding and cleanup operations to prevent ownership races.
   */
  readonly withWorktreeLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;
}

export function readCommandModel(
  engine: OrchestrationEngineShape,
): Effect.Effect<OrchestrationReadModel, never, never> {
  return engine.getCommandReadModel?.() ?? engine.getReadModel();
}

export function readThreadDetail(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
): Effect.Effect<Option.Option<OrchestrationThread>, never, never> {
  return (
    engine.getThreadDetailById?.(threadId) ??
    engine.getReadModel().pipe(
      Effect.map((readModel) => {
        const thread = readModel.threads.find((entry) => entry.id === threadId);
        return thread === undefined ? Option.none() : Option.some(thread);
      }),
    )
  );
}

export function readRecoveryModel(
  engine: OrchestrationEngineShape,
  threadId?: ThreadId,
): Effect.Effect<OrchestrationReadModel, never, never> {
  return engine.getRecoveryReadModel?.(threadId) ?? engine.getReadModel();
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.getReadModel()
 * })
 * ```
 */
export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
