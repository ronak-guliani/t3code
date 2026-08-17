import { Schema } from "effect";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { GitCommandError } from "@t3tools/contracts";

/**
 * CheckpointUnavailableError - Expected checkpoint does not exist.
 */
export class CheckpointUnavailableError extends Schema.TaggedErrorClass<CheckpointUnavailableError>()(
  "CheckpointUnavailableError",
  {
    threadId: Schema.String,
    turnCount: Schema.Number,
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.turnCount}: ${this.detail}`;
  }
}

/**
 * CheckpointInvariantError - Inconsistent provider/filesystem/catalog state.
 */
export class CheckpointInvariantError extends Schema.TaggedErrorClass<CheckpointInvariantError>()(
  "CheckpointInvariantError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Checkpoint invariant violation in ${this.operation}: ${this.detail}`;
  }
}

/**
 * CheckpointRefUnavailableError - A filesystem checkpoint range endpoint does not exist.
 */
export class CheckpointRefUnavailableError extends Schema.TaggedErrorClass<CheckpointRefUnavailableError>()(
  "CheckpointRefUnavailableError",
  {
    endpoint: Schema.Literals(["from", "to"]),
  },
) {
  override get message(): string {
    return `Checkpoint ${this.endpoint} ref is unavailable.`;
  }
}

export type CheckpointStoreError =
  | GitCommandError
  | CheckpointInvariantError
  | CheckpointRefUnavailableError
  | CheckpointUnavailableError;

export type CheckpointServiceError = CheckpointStoreError | ProjectionRepositoryError;
