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

export const ValidationResultStatus = Schema.Literals(["passed", "failed", "blocked"]);
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

const validationGate = (input: {
  readonly id: string;
  readonly kind: ValidationGateKind;
  readonly label: string;
  readonly required: boolean;
  readonly command: string | null;
  readonly requestedAt: IsoDateTime;
}): ValidationGate => ({
  id: input.id,
  label: input.label,
  kind: input.kind,
  instanceId: input.id,
  required: input.required,
  status: input.required ? "pending" : "not-required",
  command: input.command,
  requestedAt: input.requestedAt,
  startedAt: null,
  completedAt: null,
  exitCode: null,
  outputRef: null,
  blockerReason: null,
  diagnostics: [],
  attempts: [],
  result: null,
});

export const planValidationCoordinatorRun = (input: {
  readonly id: string;
  readonly requestId: string;
  readonly threadId: ThreadId;
  readonly target: ValidationTarget;
  readonly scenarios: ReadonlyArray<ValidationScenario>;
  readonly scope: ValidationScope;
  readonly requester: ValidationRequester;
  readonly requestedAt: IsoDateTime;
}): ValidationRun => {
  const gates: ValidationGate[] =
    input.scope === "full"
      ? [
          validationGate({
            id: `${input.id}:format`,
            kind: "format",
            label: "Format",
            required: true,
            command: "pnpm fmt:check",
            requestedAt: input.requestedAt,
          }),
          validationGate({
            id: `${input.id}:lint`,
            kind: "lint",
            label: "Lint",
            required: true,
            command: "pnpm lint",
            requestedAt: input.requestedAt,
          }),
          validationGate({
            id: `${input.id}:typecheck`,
            kind: "typecheck",
            label: "Typecheck",
            required: true,
            command: "pnpm typecheck",
            requestedAt: input.requestedAt,
          }),
          validationGate({
            id: `${input.id}:full-tests`,
            kind: "full-tests",
            label: "Full tests",
            required: true,
            command: "pnpm test",
            requestedAt: input.requestedAt,
          }),
        ]
      : [
          validationGate({
            id: `${input.id}:focused-tests`,
            kind: "focused-tests",
            label: "Focused tests",
            required: true,
            command: null,
            requestedAt: input.requestedAt,
          }),
        ];

  for (const scenario of input.scenarios) {
    gates.push(
      validationGate({
        id: `${input.id}:browser-scenario:${scenario.id}`,
        kind: "browser-scenario",
        label: scenario.description ?? `Browser scenario: ${scenario.id}`,
        required: true,
        command: "real-client browser scenario",
        requestedAt: input.requestedAt,
      }),
    );
  }

  gates.push(
    validationGate({
      id: `${input.id}:pairing-self-test`,
      kind: "pairing-self-test",
      label: "Pairing self-test",
      required: false,
      command: "pnpm test:self",
      requestedAt: input.requestedAt,
    }),
  );

  return {
    id: input.id,
    threadId: input.threadId,
    requestId: input.requestId,
    status: "planned",
    scope: input.scope,
    scenarios: [...input.scenarios],
    requester: input.requester,
    target: input.target,
    lease: null,
    gates,
    createdAt: input.requestedAt,
    updatedAt: input.requestedAt,
  };
};

export const planValidationRun = (input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly executorId?: string | undefined;
  readonly target: ValidationTarget;
  readonly requestedAt: IsoDateTime;
}): ValidationRun => ({
  id: input.id,
  threadId: input.threadId,
  status: "planned",
  scope: "changed-behavior",
  scenarios: [],
  ...(input.executorId !== undefined ? { executorId: input.executorId } : {}),
  target: input.target,
  lease: null,
  gates: [
    {
      id: "repository-tests",
      label: "Repository tests",
      kind: "repository-tests",
      instanceId: "repository-tests",
      required: true,
      status: "pending",
      command: "pnpm test",
      requestedAt: input.requestedAt,
      startedAt: null,
      completedAt: null,
      exitCode: null,
      outputRef: null,
      blockerReason: null,
      diagnostics: [],
      attempts: [],
      result: null,
    },
    {
      id: "browser-validation",
      label: "Browser validation",
      kind: "browser-validation",
      instanceId: "browser-validation",
      required: true,
      status: "pending",
      command: "real-client browser validation",
      requestedAt: input.requestedAt,
      startedAt: null,
      completedAt: null,
      exitCode: null,
      outputRef: null,
      blockerReason: null,
      diagnostics: [],
      attempts: [],
      result: null,
    },
    {
      id: "self-test",
      label: "Self-test",
      kind: "self-test",
      instanceId: "self-test",
      required: false,
      status: "not-required",
      command: "pnpm test:self",
      requestedAt: input.requestedAt,
      startedAt: null,
      completedAt: null,
      exitCode: null,
      outputRef: null,
      blockerReason: null,
      diagnostics: [],
      attempts: [],
      result: null,
    },
  ],
  createdAt: input.requestedAt,
  updatedAt: input.requestedAt,
});

export const transitionValidationGate = (
  run: ValidationRun,
  update: ValidationGateUpdate,
  updatedAt: IsoDateTime,
): ValidationRun => {
  const gate = run.gates.find((candidate) => candidate.id === update.gateId);
  if (!gate) {
    throw new Error(`Validation gate ${update.gateId} does not exist.`);
  }
  if (update.status === "failed" && gate.status !== "running") {
    throw new Error(`Validation gate ${update.gateId} cannot fail before it starts.`);
  }
  if (update.status === "passed" && gate.status !== "running") {
    throw new Error(`Validation gate ${update.gateId} cannot pass before it starts.`);
  }
  if (update.status === "interrupted" && gate.status !== "running") {
    throw new Error(`Validation gate ${update.gateId} cannot be interrupted before it starts.`);
  }
  if (update.status === "running" && gate.status === "not-required") {
    throw new Error(`Validation gate ${update.gateId} must be requested before it runs.`);
  }
  return {
    ...run,
    gates: run.gates.map((candidate) =>
      candidate.id === update.gateId
        ? {
            ...candidate,
            status: update.status,
            command: update.command,
            startedAt: update.startedAt,
            completedAt: update.completedAt,
            exitCode: update.exitCode,
            outputRef: update.outputRef,
            blockerReason: update.blockerReason,
            diagnostics: [...update.diagnostics],
            attempts: candidate.attempts,
            result: candidate.result,
          }
        : candidate,
    ),
    updatedAt,
  };
};

export const validationRunStatusLabel = (status: ValidationRunStatus): string => {
  switch (status) {
    case "planned":
      return "Planned";
    case "preparing":
      return "Preparing";
    case "running":
      return "Running";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    case "interrupted":
      return "Interrupted";
    case "stale":
      return "Stale";
  }
};

const legalRunTransitions: Record<ValidationRunStatus, ReadonlyArray<ValidationRunStatus>> = {
  planned: ["preparing", "blocked", "interrupted", "stale"],
  preparing: ["running", "failed", "blocked", "interrupted", "stale"],
  running: ["ready", "failed", "blocked", "interrupted", "stale"],
  ready: ["stale"],
  failed: ["planned", "stale"],
  blocked: ["planned", "stale"],
  interrupted: ["planned", "stale"],
  stale: [],
};

export const transitionValidationRunStatus = (
  run: ValidationRun,
  nextStatus: ValidationRunStatus,
  updatedAt: IsoDateTime,
): ValidationRun => {
  const currentStatus = run.status ?? "planned";
  if (currentStatus === nextStatus) {
    return { ...run, status: nextStatus, updatedAt };
  }
  if (!legalRunTransitions[currentStatus].includes(nextStatus)) {
    throw new Error(`Validation run cannot transition from ${currentStatus} to ${nextStatus}.`);
  }
  return { ...run, status: nextStatus, updatedAt };
};

export const acceptValidationResult = (
  run: ValidationRun,
  result: ValidationStructuredResult,
): ValidationRun => {
  if (result.runId !== run.id) {
    throw new Error("Validation result does not match the active run.");
  }
  if ((run.status ?? "planned") !== "running") {
    throw new Error(
      `Validation result cannot be accepted while the run is ${run.status ?? "planned"}.`,
    );
  }
  if (!validationTargetEquals(run.target, result.target)) {
    throw new Error("Validation result target does not match the planned target.");
  }
  const gate = run.gates.find((candidate) => candidate.id === result.gateId);
  if (!gate) {
    throw new Error(`Validation gate ${result.gateId} does not exist.`);
  }
  if (gate.status !== "running") {
    throw new Error(`Validation gate ${result.gateId} is not running.`);
  }
  if (!run.lease || run.lease.id !== result.leaseId) {
    throw new Error("Validation result is not attached to the active lease.");
  }
  if (run.executorId !== undefined && run.executorId !== result.executorId) {
    throw new Error("Validation result is not owned by the active executor.");
  }
  if (Date.parse(result.completedAt) > Date.parse(run.lease.expiresAt)) {
    throw new Error("Validation result arrived after the active lease expired.");
  }
  if (gate.attempts.some((attempt) => attempt.id === result.attemptId)) {
    return run;
  }
  const attempt: ValidationAttempt = {
    id: result.attemptId,
    executorId: result.executorId,
    target: result.target,
    startedAt: gate.startedAt ?? result.observedAt,
    completedAt: result.completedAt,
    result,
  };
  const nextGates = run.gates.map((candidate) =>
    candidate.id === gate.id
      ? {
          ...candidate,
          status: result.status,
          completedAt: result.completedAt,
          exitCode: result.exitCode,
          outputRef: result.outputRef,
          blockerReason: result.blockerReason,
          diagnostics: [...result.diagnostics],
          attempts: [...candidate.attempts, attempt],
          result,
        }
      : candidate,
  );
  const nextStatus =
    result.status === "failed"
      ? "failed"
      : result.status === "blocked"
        ? "blocked"
        : nextGates.every(
              (candidate) =>
                !candidate.required ||
                candidate.status === "passed" ||
                candidate.status === "not-required",
            )
          ? "ready"
          : "running";
  return {
    ...run,
    status: nextStatus,
    gates: nextGates,
    updatedAt: result.completedAt,
  };
};

export const validationTargetEquals = (left: ValidationTarget, right: ValidationTarget): boolean =>
  left.workspaceRoot === right.workspaceRoot &&
  left.worktreePath === right.worktreePath &&
  left.branch === right.branch &&
  left.revision === right.revision &&
  left.dirtyStateFingerprint === right.dirtyStateFingerprint &&
  left.environmentIdentity === right.environmentIdentity;

export const validationRunEquals = (
  left: ValidationRun | null | undefined,
  right: ValidationRun | null | undefined,
): boolean => {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  if (
    left.id !== right.id ||
    left.threadId !== right.threadId ||
    left.executorId !== right.executorId ||
    left.createdAt !== right.createdAt ||
    left.updatedAt !== right.updatedAt ||
    !validationTargetEquals(left.target, right.target) ||
    left.gates.length !== right.gates.length
  ) {
    return false;
  }
  return left.gates.every((leftGate, index) => {
    const rightGate = right.gates[index];
    if (!rightGate) return false;
    return (
      leftGate.id === rightGate.id &&
      leftGate.label === rightGate.label &&
      leftGate.required === rightGate.required &&
      leftGate.status === rightGate.status &&
      leftGate.command === rightGate.command &&
      leftGate.requestedAt === rightGate.requestedAt &&
      leftGate.startedAt === rightGate.startedAt &&
      leftGate.completedAt === rightGate.completedAt &&
      leftGate.exitCode === rightGate.exitCode &&
      leftGate.outputRef === rightGate.outputRef &&
      leftGate.blockerReason === rightGate.blockerReason &&
      leftGate.diagnostics.length === rightGate.diagnostics.length &&
      leftGate.diagnostics.every((diagnostic, diagnosticIndex) => {
        return diagnostic === rightGate.diagnostics[diagnosticIndex];
      })
    );
  });
};

export const reduceValidationReadiness = (
  run: ValidationRun | null | undefined,
  currentTarget: ValidationTarget,
): ValidationReadiness => {
  if (!run) return "not-ready";
  if (!validationTargetEquals(run.target, currentTarget)) return "stale";
  return run.gates.every(
    (gate) => !gate.required || gate.status === "passed" || gate.status === "not-required",
  )
    ? "ready"
    : "not-ready";
};

export const validationGateStatusLabel = (status: ValidationGateStatus): string => {
  switch (status) {
    case "not-required":
      return "Not required";
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    case "interrupted":
      return "Interrupted";
  }
};
