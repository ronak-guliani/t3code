import { Cause, Effect, Exit, Schema } from "effect";

export const NestedThreadCreationErrorCode = Schema.Literals([
  "VALIDATION_FAILED",
  "WORKSPACE_PATH_OCCUPIED",
  "WORKSPACE_PATH_REGISTERED",
  "WORKSPACE_BRANCH_INVALID",
  "WORKSPACE_BRANCH_EXISTS",
  "WORKSPACE_BASE_REF_MISSING",
  "WORKSPACE_REPOSITORY_MISMATCH",
  "WORKSPACE_PREFLIGHT_FAILED",
  "WORKSPACE_CREATE_FAILED",
  "WORKSPACE_CLEANUP_FAILED",
  "THREAD_CREATE_REJECTED",
  "THREAD_CREATE_AMBIGUOUS",
  "TURN_START_REJECTED",
  "TURN_START_AMBIGUOUS",
  "THREAD_CLEANUP_REJECTED",
  "THREAD_CLEANUP_AMBIGUOUS",
  "CLI_EXECUTION_FAILED",
  "CLI_RESPONSE_INVALID",
]);
export type NestedThreadCreationErrorCode = typeof NestedThreadCreationErrorCode.Type;

export const NestedThreadCreationOutcome = Schema.Struct({
  status: Schema.Literals(["created", "dry-run", "failed", "ambiguous"]),
  threadId: Schema.NullOr(Schema.String),
  retryable: Schema.Boolean,
  workspaceCreated: Schema.Boolean,
  cleanupPerformed: Schema.Boolean,
  errorCode: Schema.NullOr(NestedThreadCreationErrorCode),
  message: Schema.String,
});
export type NestedThreadCreationOutcome = typeof NestedThreadCreationOutcome.Type;

export interface NestedThreadPhaseFailure {
  readonly definitive: boolean;
  readonly message: string;
}

interface NestedThreadCreationPhases<R> {
  readonly createThread: Effect.Effect<void, unknown, R>;
  readonly startTurn: Effect.Effect<void, unknown, R>;
  readonly cleanupThread: Effect.Effect<void, unknown, R>;
  readonly classifyFailure: (error: unknown) => NestedThreadPhaseFailure;
}

const failureFromCause = (
  cause: Cause.Cause<unknown>,
  classifyFailure: (error: unknown) => NestedThreadPhaseFailure,
): NestedThreadPhaseFailure => {
  const error = Cause.findErrorOption(cause);
  return error._tag === "Some"
    ? classifyFailure(error.value)
    : { definitive: false, message: Cause.pretty(cause) };
};

export const runNestedThreadCreationPhases = <R>(
  threadId: string,
  workspaceCreated: boolean,
  phases: NestedThreadCreationPhases<R>,
): Effect.Effect<NestedThreadCreationOutcome, never, R> =>
  Effect.gen(function* () {
    const createExit = yield* Effect.exit(phases.createThread);
    if (Exit.isFailure(createExit)) {
      const failure = failureFromCause(createExit.cause, phases.classifyFailure);
      return {
        status: failure.definitive ? "failed" : "ambiguous",
        threadId: failure.definitive ? null : threadId,
        retryable: failure.definitive,
        workspaceCreated,
        cleanupPerformed: false,
        errorCode: failure.definitive ? "THREAD_CREATE_REJECTED" : "THREAD_CREATE_AMBIGUOUS",
        message: failure.definitive
          ? `Thread creation was rejected before it committed: ${failure.message}`
          : `Thread creation may have committed, so retrying could create a duplicate. Inspect child thread '${threadId}' before retrying: ${failure.message}`,
      };
    }

    const turnExit = yield* Effect.exit(phases.startTurn);
    if (Exit.isSuccess(turnExit)) {
      return {
        status: "created",
        threadId,
        retryable: false,
        workspaceCreated,
        cleanupPerformed: false,
        errorCode: null,
        message: "Nested thread created and its first turn was accepted.",
      };
    }

    const turnFailure = failureFromCause(turnExit.cause, phases.classifyFailure);
    if (!turnFailure.definitive) {
      return {
        status: "ambiguous",
        threadId,
        retryable: false,
        workspaceCreated,
        cleanupPerformed: false,
        errorCode: "TURN_START_AMBIGUOUS",
        message: `The thread was created, but its first turn may have been accepted. The thread was preserved to avoid interrupting committed work: ${turnFailure.message}`,
      };
    }

    const cleanupExit = yield* Effect.exit(phases.cleanupThread);
    if (Exit.isSuccess(cleanupExit)) {
      return {
        status: "failed",
        threadId,
        retryable: true,
        workspaceCreated,
        cleanupPerformed: true,
        errorCode: "TURN_START_REJECTED",
        message: `The first turn was rejected and cleanup was accepted, so creation can be retried safely: ${turnFailure.message}`,
      };
    }

    const cleanupFailure = failureFromCause(cleanupExit.cause, phases.classifyFailure);
    return {
      status: cleanupFailure.definitive ? "failed" : "ambiguous",
      threadId,
      retryable: false,
      workspaceCreated,
      cleanupPerformed: false,
      errorCode: cleanupFailure.definitive ? "THREAD_CLEANUP_REJECTED" : "THREAD_CLEANUP_AMBIGUOUS",
      message: cleanupFailure.definitive
        ? `The first turn was rejected, but thread cleanup was also rejected. Delete child thread '${threadId}' before retrying: ${cleanupFailure.message}`
        : `The first turn was rejected, but cleanup may have committed. Inspect child thread '${threadId}' before retrying: ${cleanupFailure.message}`,
    };
  });

export const decodeNestedThreadCreationOutcome = Schema.decodeUnknownSync(
  NestedThreadCreationOutcome,
);
