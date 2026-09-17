import { Effect, Schema } from "effect";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ValidationGateId = Schema.Literals([
  "repository-tests",
  "browser-validation",
  "self-test",
]);
export type ValidationGateId = typeof ValidationGateId.Type;

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

export const ValidationTarget = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  revision: TrimmedNonEmptyString,
  dirtyStateFingerprint: TrimmedNonEmptyString,
  environmentIdentity: TrimmedNonEmptyString,
});
export type ValidationTarget = typeof ValidationTarget.Type;

export const ValidationGate = Schema.Struct({
  id: ValidationGateId,
  label: TrimmedNonEmptyString,
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
});
export type ValidationGate = typeof ValidationGate.Type;

export const ValidationRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  target: ValidationTarget,
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

const gateLabel: Record<ValidationGateId, string> = {
  "repository-tests": "Repository tests",
  "browser-validation": "Browser validation",
  "self-test": "test:self",
};

export const planValidationRun = (input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly target: ValidationTarget;
  readonly requestedAt: IsoDateTime;
}): ValidationRun => ({
  id: input.id,
  threadId: input.threadId,
  target: input.target,
  gates: [
    {
      id: "repository-tests",
      label: gateLabel["repository-tests"],
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
    },
    {
      id: "browser-validation",
      label: gateLabel["browser-validation"],
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
    },
    {
      id: "self-test",
      label: gateLabel["self-test"],
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
          }
        : candidate,
    ),
    updatedAt,
  };
};

export const validationTargetEquals = (left: ValidationTarget, right: ValidationTarget): boolean =>
  left.workspaceRoot === right.workspaceRoot &&
  left.worktreePath === right.worktreePath &&
  left.branch === right.branch &&
  left.revision === right.revision &&
  left.dirtyStateFingerprint === right.dirtyStateFingerprint &&
  left.environmentIdentity === right.environmentIdentity;

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
