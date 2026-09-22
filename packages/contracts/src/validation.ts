import { Effect, Schema } from "effect";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ValidationGateId = TrimmedNonEmptyString;
export type ValidationGateId = typeof ValidationGateId.Type;

export const ValidationGateKind = Schema.Literals([
  "focused-tests",
  "format",
  "lint",
  "typecheck",
  "full-tests",
  "pairing-self-test",
  "browser-scenario",
  "repository-tests",
  "browser-validation",
  "self-test",
]);
export type ValidationGateKind = typeof ValidationGateKind.Type;

export const ValidationGateStatus = Schema.Literals([
  "not-required",
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "interrupted",
]);
export type ValidationGateStatus = typeof ValidationGateStatus.Type;

export const ValidationReadiness = Schema.Literals(["ready", "not-ready", "stale"]);
export type ValidationReadiness = typeof ValidationReadiness.Type;

export const ValidationRunStatus = Schema.Literals([
  "planned",
  "preparing",
  "running",
  "ready",
  "failed",
  "blocked",
  "interrupted",
  "stale",
]);
export type ValidationRunStatus = typeof ValidationRunStatus.Type;

export const ValidationScope = Schema.Literals(["changed-behavior", "full"]);
export type ValidationScope = typeof ValidationScope.Type;

export const ValidationRequesterKind = Schema.Literals(["user", "provider", "system"]);
export type ValidationRequesterKind = typeof ValidationRequesterKind.Type;

export const ValidationRequester = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ValidationRequesterKind,
});
export type ValidationRequester = typeof ValidationRequester.Type;

export const ValidationScenario = Schema.Struct({
  id: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
});
export type ValidationScenario = typeof ValidationScenario.Type;

export const ValidationTarget = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  revision: TrimmedNonEmptyString,
  dirtyStateFingerprint: TrimmedNonEmptyString,
  environmentIdentity: TrimmedNonEmptyString,
});
export type ValidationTarget = typeof ValidationTarget.Type;

export const ValidationLease = Schema.Struct({
  id: TrimmedNonEmptyString,
  executorId: TrimmedNonEmptyString,
  claimedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type ValidationLease = typeof ValidationLease.Type;

export const ValidationResultStatus = Schema.Literals([
  "passed",
  "failed",
  "blocked",
  "interrupted",
]);
export type ValidationResultStatus = typeof ValidationResultStatus.Type;

export const ValidationStructuredResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  gateId: ValidationGateId,
  attemptId: TrimmedNonEmptyString,
  leaseId: TrimmedNonEmptyString,
  executorId: TrimmedNonEmptyString,
  target: ValidationTarget,
  status: ValidationResultStatus,
  observedAt: IsoDateTime,
  completedAt: IsoDateTime,
  exitCode: Schema.NullOr(Schema.Int),
  outputRef: Schema.NullOr(TrimmedNonEmptyString),
  blockerReason: Schema.NullOr(TrimmedNonEmptyString),
  diagnostics: Schema.Array(TrimmedNonEmptyString),
});
export type ValidationStructuredResult = typeof ValidationStructuredResult.Type;

export const ValidationAttempt = Schema.Struct({
  id: TrimmedNonEmptyString,
  executorId: TrimmedNonEmptyString,
  target: ValidationTarget,
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  result: Schema.NullOr(ValidationStructuredResult),
});
export type ValidationAttempt = typeof ValidationAttempt.Type;

export const ValidationGate = Schema.Struct({
  id: ValidationGateId,
  label: TrimmedNonEmptyString,
  kind: Schema.optional(ValidationGateKind),
  instanceId: Schema.optional(TrimmedNonEmptyString),
  required: Schema.Boolean,
  status: ValidationGateStatus,
  command: Schema.NullOr(TrimmedNonEmptyString),
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  exitCode: Schema.NullOr(Schema.Int),
  outputRef: Schema.NullOr(TrimmedNonEmptyString),
  blockerReason: Schema.NullOr(TrimmedNonEmptyString),
  diagnostics: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  attempts: Schema.Array(ValidationAttempt).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  result: Schema.NullOr(ValidationStructuredResult).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type ValidationGate = typeof ValidationGate.Type;

export const ValidationRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  requestId: Schema.optional(TrimmedNonEmptyString),
  status: Schema.optional(ValidationRunStatus),
  scope: Schema.optional(ValidationScope),
  scenarios: Schema.Array(ValidationScenario).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  requester: Schema.optional(ValidationRequester),
  executorId: Schema.optional(TrimmedNonEmptyString),
  target: ValidationTarget,
  lease: Schema.NullOr(ValidationLease).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  gates: Schema.Array(ValidationGate),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ValidationRun = typeof ValidationRun.Type;

export const ValidationGateUpdate = Schema.Struct({
  gateId: ValidationGateId,
  status: ValidationGateStatus,
  command: Schema.NullOr(TrimmedNonEmptyString),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  exitCode: Schema.NullOr(Schema.Int),
  outputRef: Schema.NullOr(TrimmedNonEmptyString),
  blockerReason: Schema.NullOr(TrimmedNonEmptyString),
  diagnostics: Schema.Array(TrimmedNonEmptyString),
});
export type ValidationGateUpdate = typeof ValidationGateUpdate.Type;

export const ValidationRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  scenarios: Schema.Array(ValidationScenario),
  scope: ValidationScope,
  requester: ValidationRequester,
  requestedAt: IsoDateTime,
});
export type ValidationRequest = typeof ValidationRequest.Type;

export const ValidationRequestFailure = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
  failedAt: IsoDateTime,
});
export type ValidationRequestFailure = typeof ValidationRequestFailure.Type;

export const ValidationRunLifecycleUpdate = Schema.Struct({
  runId: TrimmedNonEmptyString,
  status: ValidationRunStatus,
  reason: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type ValidationRunLifecycleUpdate = typeof ValidationRunLifecycleUpdate.Type;
