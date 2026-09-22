import type {
  OrchestrationEvent,
  ThreadId,
  ValidationGate,
  ValidationGateKind,
  ValidationGateStatus,
  ValidationGateUpdate,
  ValidationLease,
  ValidationReadiness,
  ValidationRequest,
  ValidationRequester,
  ValidationRun,
  ValidationRunStatus,
  ValidationScenario,
  ValidationScope,
  ValidationStructuredResult,
  ValidationTarget,
} from "@t3tools/contracts";

const VALIDATION_EVENT_TYPES = [
  "thread.validation-requested",
  "thread.validation-request-failed",
  "thread.validation-run-planned",
  "thread.validation-lifecycle-updated",
  "thread.validation-lease-claimed",
  "thread.validation-lease-released",
  "thread.validation-result-recorded",
  "thread.validation-gate-updated",
] as const;

export type ValidationLifecycleEventType = (typeof VALIDATION_EVENT_TYPES)[number];
export type ValidationLifecycleEvent = Extract<
  OrchestrationEvent,
  { type: ValidationLifecycleEventType }
>;

export interface ValidationLifecycleState {
  readonly request: ValidationRequest | null;
  readonly run: ValidationRun | null;
}

export type ValidationRecoveryDecision =
  | {
      readonly type: "resume-interrupted";
      readonly gateIds: ReadonlyArray<string>;
      readonly reason: string;
    }
  | {
      readonly type: "interrupt-running";
      readonly gateId: string;
      readonly reason: string;
    }
  | {
      readonly type: "none";
    };

const DEFAULT_FULL_GATE_KINDS: ReadonlyArray<ValidationGateKind> = [
  "format",
  "lint",
  "typecheck",
  "full-tests",
];
const DEFAULT_CHANGED_BEHAVIOR_GATE_KINDS: ReadonlyArray<ValidationGateKind> = ["focused-tests"];
function orderedRequiredGateKinds(
  scope: ValidationScope,
  kinds: ReadonlySet<ValidationGateKind> | ReadonlyArray<ValidationGateKind> | undefined,
): ReadonlyArray<ValidationGateKind> {
  if (kinds === undefined) {
    return scope === "full" ? DEFAULT_FULL_GATE_KINDS : DEFAULT_CHANGED_BEHAVIOR_GATE_KINDS;
  }
  return [...new Set(kinds)];
}

function makeValidationGate(input: {
  readonly id: string;
  readonly kind: ValidationGateKind;
  readonly label: string;
  readonly required: boolean;
  readonly command: string | null;
  readonly requestedAt: string;
}): ValidationGate {
  return {
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
  };
}

export function planValidationCoordinatorRun(input: {
  readonly id: string;
  readonly requestId: string;
  readonly threadId: ThreadId;
  readonly target: ValidationTarget;
  readonly scenarios: ReadonlyArray<ValidationScenario>;
  readonly scope: ValidationScope;
  readonly requester: ValidationRequester;
  readonly requestedAt: string;
  readonly requiredGateKinds?:
    | ReadonlySet<ValidationGateKind>
    | ReadonlyArray<ValidationGateKind>
    | undefined;
}): ValidationRun {
  const orderedRequired = orderedRequiredGateKinds(input.scope, input.requiredGateKinds);
  const required = new Set(orderedRequired);
  const gateDefinitions: ReadonlyArray<{
    readonly kind: ValidationGateKind;
    readonly label: string;
    readonly command: string | null;
  }> = [
    { kind: "focused-tests", label: "Focused tests", command: null },
    { kind: "format", label: "Format", command: "pnpm fmt:check" },
    { kind: "lint", label: "Lint", command: "pnpm lint" },
    { kind: "typecheck", label: "Typecheck", command: "pnpm typecheck" },
    { kind: "full-tests", label: "Full tests", command: "pnpm test" },
  ];
  const gates: ValidationGate[] = [];

  for (const kind of orderedRequired) {
    const definition = gateDefinitions.find((candidate) => candidate.kind === kind);
    if (!definition) continue;
    gates.push(
      makeValidationGate({
        id: `${input.id}:${definition.kind}`,
        kind: definition.kind,
        label: definition.label,
        required: true,
        command: definition.command,
        requestedAt: input.requestedAt,
      }),
    );
  }

  for (const scenario of input.scenarios) {
    gates.push(
      makeValidationGate({
        id: `${input.id}:browser-scenario:${scenario.id}`,
        kind: "browser-scenario",
        label: scenario.description ?? `Browser scenario: ${scenario.id}`,
        required: true,
        command: "real-client browser scenario",
        requestedAt: input.requestedAt,
      }),
    );
  }

  if (required.has("browser-validation") && input.scenarios.length === 0) {
    gates.push(
      makeValidationGate({
        id: `${input.id}:browser-validation`,
        kind: "browser-validation",
        label: "Browser validation",
        required: true,
        command: "real-client browser validation",
        requestedAt: input.requestedAt,
      }),
    );
  }

  gates.push(
    makeValidationGate({
      id: `${input.id}:pairing-self-test`,
      kind: "pairing-self-test",
      label: "Pairing self-test",
      required: required.has("pairing-self-test"),
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
}

export function planValidationRun(input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly executorId?: string | undefined;
  readonly target: ValidationTarget;
  readonly requestedAt: string;
}): ValidationRun {
  return {
    id: input.id,
    threadId: input.threadId,
    status: "planned",
    scope: "changed-behavior",
    scenarios: [],
    ...(input.executorId !== undefined ? { executorId: input.executorId } : {}),
    target: input.target,
    lease: null,
    gates: [
      makeValidationGate({
        id: "repository-tests",
        kind: "repository-tests",
        label: "Repository tests",
        required: true,
        command: "pnpm test",
        requestedAt: input.requestedAt,
      }),
      makeValidationGate({
        id: "browser-validation",
        kind: "browser-validation",
        label: "Browser validation",
        required: true,
        command: "real-client browser validation",
        requestedAt: input.requestedAt,
      }),
      makeValidationGate({
        id: "self-test",
        kind: "self-test",
        label: "Self-test",
        required: false,
        command: "pnpm test:self",
        requestedAt: input.requestedAt,
      }),
    ],
    createdAt: input.requestedAt,
    updatedAt: input.requestedAt,
  };
}

export const validationTargetEquals = (left: ValidationTarget, right: ValidationTarget): boolean =>
  left.workspaceRoot === right.workspaceRoot &&
  left.worktreePath === right.worktreePath &&
  left.branch === right.branch &&
  left.revision === right.revision &&
  left.dirtyStateFingerprint === right.dirtyStateFingerprint &&
  left.environmentIdentity === right.environmentIdentity;

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

export const validationRunEffectiveStatus = (run: ValidationRun): ValidationRunStatus => {
  if (run.status !== undefined) return run.status;
  if (run.gates.some((gate) => gate.status === "failed")) return "failed";
  if (run.gates.some((gate) => gate.status === "blocked")) return "blocked";
  if (
    run.gates.every(
      (gate) => !gate.required || gate.status === "passed" || gate.status === "not-required",
    )
  ) {
    return "ready";
  }
  return "planned";
};

export const isValidationRunTerminal = (status: ValidationRunStatus): boolean =>
  status === "ready" ||
  status === "failed" ||
  status === "blocked" ||
  status === "interrupted" ||
  status === "stale";

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

export function transitionValidationRunStatus(
  run: ValidationRun,
  nextStatus: ValidationRunStatus,
  updatedAt: string,
): ValidationRun {
  const currentStatus = validationRunEffectiveStatus(run);
  if (currentStatus === nextStatus) {
    return { ...run, status: nextStatus, updatedAt };
  }
  if (!legalRunTransitions[currentStatus].includes(nextStatus)) {
    throw new Error(`Validation run cannot transition from ${currentStatus} to ${nextStatus}.`);
  }
  return { ...run, status: nextStatus, updatedAt };
}

export function transitionValidationGate(
  run: ValidationRun,
  update: ValidationGateUpdate,
  updatedAt: string,
): ValidationRun {
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
}

export function claimValidationLease(
  run: ValidationRun,
  lease: ValidationLease,
  target: ValidationTarget,
  updatedAt: string,
): ValidationRun {
  if (isValidationRunTerminal(validationRunEffectiveStatus(run))) {
    throw new Error("Validation lease claim cannot target a terminal run.");
  }
  if (!validationTargetEquals(run.target, target)) {
    throw new Error("Validation lease claim target does not match the planned target.");
  }
  if (run.lease !== null) {
    if (
      run.lease.id !== lease.id ||
      run.lease.executorId !== lease.executorId ||
      run.lease.expiresAt !== lease.expiresAt
    ) {
      throw new Error("Validation run already has an active lease.");
    }
    return run;
  }
  return {
    ...run,
    executorId: lease.executorId,
    lease,
    updatedAt,
  };
}

export function releaseValidationLease(
  run: ValidationRun,
  leaseId: string,
  updatedAt: string,
): ValidationRun {
  if (run.lease?.id !== leaseId) return run;
  return {
    ...run,
    lease: null,
    updatedAt,
  };
}

export function acceptValidationResult(
  run: ValidationRun,
  result: ValidationStructuredResult,
): ValidationRun {
  if (result.runId !== run.id) {
    throw new Error("Validation result does not match the active run.");
  }
  if (validationRunEffectiveStatus(run) !== "running") {
    throw new Error(
      `Validation result cannot be accepted while the run is ${validationRunEffectiveStatus(run)}.`,
    );
  }
  if (!validationTargetEquals(run.target, result.target)) {
    throw new Error("Validation result target does not match the planned target.");
  }
  const gate = run.gates.find((candidate) => candidate.id === result.gateId);
  if (!gate) {
    throw new Error(`Validation gate ${result.gateId} does not exist.`);
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
  const existingAttempt = gate.attempts.find((attempt) => attempt.id === result.attemptId);
  if (existingAttempt) {
    if (
      existingAttempt.result === null ||
      JSON.stringify(existingAttempt.result) !== JSON.stringify(result)
    ) {
      throw new Error("Validation result does not match the existing attempt.");
    }
    return run;
  }
  if (gate.status !== "running") {
    throw new Error(`Validation gate ${result.gateId} is not running.`);
  }
  const attempt = {
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
        : result.status === "interrupted"
          ? "interrupted"
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
}

export function reduceValidationReadiness(
  run: ValidationRun | null | undefined,
  currentTarget: ValidationTarget,
): ValidationReadiness {
  if (!run) return "not-ready";
  if (!validationTargetEquals(run.target, currentTarget)) return "stale";
  return run.gates.every(
    (gate) => !gate.required || gate.status === "passed" || gate.status === "not-required",
  )
    ? "ready"
    : "not-ready";
}

export const validationRunEquals = (
  left: ValidationRun | null | undefined,
  right: ValidationRun | null | undefined,
): boolean => {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  if (
    left.id !== right.id ||
    left.threadId !== right.threadId ||
    left.requestId !== right.requestId ||
    left.status !== right.status ||
    left.scope !== right.scope ||
    JSON.stringify(left.scenarios) !== JSON.stringify(right.scenarios) ||
    JSON.stringify(left.requester) !== JSON.stringify(right.requester) ||
    left.executorId !== right.executorId ||
    JSON.stringify(left.lease) !== JSON.stringify(right.lease) ||
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
      leftGate.kind === rightGate.kind &&
      leftGate.instanceId === rightGate.instanceId &&
      leftGate.required === rightGate.required &&
      leftGate.status === rightGate.status &&
      leftGate.command === rightGate.command &&
      leftGate.requestedAt === rightGate.requestedAt &&
      leftGate.startedAt === rightGate.startedAt &&
      leftGate.completedAt === rightGate.completedAt &&
      leftGate.exitCode === rightGate.exitCode &&
      leftGate.outputRef === rightGate.outputRef &&
      leftGate.blockerReason === rightGate.blockerReason &&
      JSON.stringify(leftGate.attempts) === JSON.stringify(rightGate.attempts) &&
      JSON.stringify(leftGate.result) === JSON.stringify(rightGate.result) &&
      leftGate.diagnostics.length === rightGate.diagnostics.length &&
      leftGate.diagnostics.every((diagnostic, diagnosticIndex) => {
        return diagnostic === rightGate.diagnostics[diagnosticIndex];
      })
    );
  });
};

export function selectNextRunnableGate(
  gates: ReadonlyArray<ValidationGate>,
): ValidationGate | undefined {
  return gates.find((gate, index) => {
    if (!gate.required || gate.status !== "pending") return false;
    for (let i = 0; i < index; i += 1) {
      const earlier = gates[i];
      if (!earlier || !earlier.required) continue;
      if (earlier.status !== "passed" && earlier.status !== "not-required") return false;
    }
    return true;
  });
}

export function decideValidationRecovery(run: ValidationRun): ValidationRecoveryDecision {
  const status = validationRunEffectiveStatus(run);
  if (status === "interrupted") {
    return {
      type: "resume-interrupted",
      gateIds: run.gates.filter((gate) => gate.status === "interrupted").map((gate) => gate.id),
      reason: "Gate reset to pending after the run was interrupted.",
    };
  }
  const runningGate =
    status === "running" ? run.gates.find((gate) => gate.status === "running") : null;
  if (runningGate) {
    return {
      type: "interrupt-running",
      gateId: runningGate.id,
      reason: "Reactor restarted during gate execution.",
    };
  }
  return { type: "none" };
}

export function isValidationLifecycleEvent(
  event: OrchestrationEvent,
): event is ValidationLifecycleEvent {
  return (VALIDATION_EVENT_TYPES as ReadonlyArray<string>).includes(event.type);
}

function applyGateEvent(
  run: ValidationRun,
  gate: ValidationGate,
  updatedAt: string,
): ValidationRun {
  return transitionValidationGate(
    run,
    {
      gateId: gate.id,
      status: gate.status,
      command: gate.command,
      startedAt: gate.startedAt,
      completedAt: gate.completedAt,
      exitCode: gate.exitCode,
      outputRef: gate.outputRef,
      blockerReason: gate.blockerReason,
      diagnostics: gate.diagnostics,
    },
    updatedAt,
  );
}

export function applyValidationEvent(
  state: ValidationLifecycleState,
  event: ValidationLifecycleEvent,
): ValidationLifecycleState {
  switch (event.type) {
    case "thread.validation-requested":
      return { request: event.payload.request, run: state.run };
    case "thread.validation-request-failed":
      return state.request?.requestId === event.payload.failure.requestId
        ? { request: null, run: state.run }
        : state;
    case "thread.validation-run-planned":
      return { request: null, run: event.payload.run };
    case "thread.validation-lifecycle-updated":
      if (!state.run || state.run.id !== event.payload.update.runId) return state;
      try {
        return {
          request: state.request,
          run: transitionValidationRunStatus(
            state.run,
            event.payload.update.status,
            event.payload.update.updatedAt,
          ),
        };
      } catch {
        return state;
      }
    case "thread.validation-lease-claimed":
      if (!state.run || state.run.id !== event.payload.runId) return state;
      try {
        return {
          request: state.request,
          run: claimValidationLease(
            state.run,
            event.payload.lease,
            state.run.target,
            event.occurredAt,
          ),
        };
      } catch {
        return state;
      }
    case "thread.validation-lease-released":
      if (!state.run || state.run.id !== event.payload.runId) return state;
      return {
        request: state.request,
        run: releaseValidationLease(state.run, event.payload.leaseId, event.occurredAt),
      };
    case "thread.validation-result-recorded":
      if (!state.run || state.run.id !== event.payload.result.runId) return state;
      try {
        return {
          request: state.request,
          run: acceptValidationResult(state.run, event.payload.result),
        };
      } catch {
        return state;
      }
    case "thread.validation-gate-updated":
      if (!state.run || state.run.id !== event.payload.runId) return state;
      try {
        return {
          request: state.request,
          run: applyGateEvent(state.run, event.payload.gate, event.occurredAt),
        };
      } catch {
        return state;
      }
  }
}
