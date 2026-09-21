import { CollaborationExecutionAuthority, ThreadId, TurnId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const delegationSchema = Schema.Struct({
  assignmentId: Schema.String,
  dispatchSequence: Schema.optional(Schema.Finite),
  dispatchId: Schema.optional(Schema.String),
  dispatchTurnId: Schema.optional(Schema.NullOr(TurnId)),
});

const isDelegation = Schema.is(delegationSchema);

export type AcceptanceAuthorityThread = {
  readonly id: ThreadId | string;
  readonly nudging?: unknown;
};

export const isCompleteAcceptanceAuthority = (
  authority: CollaborationExecutionAuthority,
): boolean =>
  authority.executionId.trim().length > 0 &&
  authority.assignmentId !== undefined &&
  authority.assignmentId.trim().length > 0 &&
  Number.isSafeInteger(authority.generation) &&
  authority.generation > 0 &&
  authority.dispatchId !== null &&
  authority.dispatchId.trim().length > 0 &&
  authority.turnId !== null &&
  authority.turnId.trim().length > 0;

export const acceptanceAuthorityForThread = (
  thread: AcceptanceAuthorityThread,
): CollaborationExecutionAuthority | undefined => {
  if (thread.nudging === null || typeof thread.nudging !== "object") {
    return undefined;
  }
  const rawDelegation = "delegation" in thread.nudging ? thread.nudging.delegation : undefined;
  const delegation = isDelegation(rawDelegation) ? rawDelegation : undefined;
  if (
    delegation?.assignmentId.trim().length === 0 ||
    delegation?.dispatchSequence === undefined ||
    !Number.isSafeInteger(delegation.dispatchSequence) ||
    delegation.dispatchSequence <= 0 ||
    delegation.dispatchId === undefined ||
    delegation.dispatchId.trim().length === 0 ||
    delegation.dispatchTurnId === undefined ||
    delegation.dispatchTurnId === null ||
    delegation.dispatchTurnId.trim().length === 0
  ) {
    return undefined;
  }
  const authority = {
    executionId: `thread:${thread.id}`,
    assignmentId: delegation.assignmentId,
    threadId: ThreadId.make(thread.id),
    generation: delegation.dispatchSequence,
    dispatchId: delegation.dispatchId,
    turnId: delegation.dispatchTurnId,
  };
  return isCompleteAcceptanceAuthority(authority) ? authority : undefined;
};

export const acceptanceAuthorityMatchesThread = (
  authority: CollaborationExecutionAuthority | undefined,
  thread: AcceptanceAuthorityThread,
): boolean => {
  const current = acceptanceAuthorityForThread(thread);
  return (
    current !== undefined &&
    authority !== undefined &&
    authority.executionId === current.executionId &&
    authority.assignmentId === current.assignmentId &&
    authority.threadId === current.threadId &&
    authority.generation === current.generation &&
    authority.dispatchId === current.dispatchId &&
    authority.turnId === current.turnId
  );
};
