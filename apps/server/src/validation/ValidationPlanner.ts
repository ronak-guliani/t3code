import type {
  ThreadId,
  ValidationGate,
  ValidationGateKind,
  ValidationRequester,
  ValidationRun,
  ValidationScenario,
  ValidationScope,
  ValidationTarget,
} from "@t3tools/contracts";

import { ValidationPolicy } from "./ValidationPolicy.ts";

export interface ValidationPlannerInput {
  readonly id: string;
  readonly requestId: string;
  readonly threadId: ThreadId;
  readonly target: ValidationTarget;
  readonly scenarios: ReadonlyArray<ValidationScenario>;
  readonly scope: ValidationScope;
  readonly requester: ValidationRequester;
  readonly requestedAt: string;
  readonly changedPaths: ReadonlyArray<string>;
}

const gate = (input: {
  readonly runId: string;
  readonly idSuffix: string;
  readonly kind: ValidationGateKind;
  readonly label: string;
  readonly required: boolean;
  readonly command: string | null;
  readonly requestedAt: string;
}): ValidationGate => ({
  id: `${input.runId}:${input.idSuffix}`,
  label: input.label,
  kind: input.kind,
  instanceId: `${input.runId}:${input.idSuffix}`,
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

export function planCoordinatorRunWithPolicy(input: ValidationPlannerInput): ValidationRun {
  const policy = new ValidationPolicy().classify({
    changedPaths: [...input.changedPaths],
    scope: input.scope,
  });
  const required = new Set(policy.requirements.map((requirement) => requirement.id));

  const gates: ValidationGate[] = [];

  if (required.has("focused-tests")) {
    gates.push(
      gate({
        runId: input.id,
        idSuffix: "focused-tests",
        kind: "focused-tests",
        label: "Focused tests",
        required: true,
        command: null,
        requestedAt: input.requestedAt,
      }),
    );
  }
  if (required.has("full-tests")) {
    gates.push(
      gate({
        runId: input.id,
        idSuffix: "full-tests",
        kind: "full-tests",
        label: "Full tests",
        required: true,
        command: "pnpm test",
        requestedAt: input.requestedAt,
      }),
    );
  }
  if (required.has("format")) {
    gates.push(
      gate({
        runId: input.id,
        idSuffix: "format",
        kind: "format",
        label: "Format",
        required: true,
        command: "pnpm fmt:check",
        requestedAt: input.requestedAt,
      }),
    );
  }
  if (required.has("lint")) {
    gates.push(
      gate({
        runId: input.id,
        idSuffix: "lint",
        kind: "lint",
        label: "Lint",
        required: true,
        command: "pnpm lint",
        requestedAt: input.requestedAt,
      }),
    );
  }
  if (required.has("typecheck")) {
    gates.push(
      gate({
        runId: input.id,
        idSuffix: "typecheck",
        kind: "typecheck",
        label: "Typecheck",
        required: true,
        command: "pnpm typecheck",
        requestedAt: input.requestedAt,
      }),
    );
  }

  for (const scenario of input.scenarios) {
    gates.push(
      gate({
        runId: input.id,
        idSuffix: `browser-scenario:${scenario.id}`,
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
      gate({
        runId: input.id,
        idSuffix: "browser-validation",
        kind: "browser-validation",
        label: "Browser validation",
        required: true,
        command: "real-client browser validation",
        requestedAt: input.requestedAt,
      }),
    );
  }

  gates.push(
    gate({
      runId: input.id,
      idSuffix: "pairing-self-test",
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

export function collectChangedPathsFromCheckpoints(
  checkpoints: ReadonlyArray<{
    readonly files?: ReadonlyArray<{ readonly path: string }>;
    readonly agentTouchedPaths?: ReadonlyArray<string>;
    readonly turnFiles?: ReadonlyArray<{ readonly path: string }>;
  }>,
): string[] {
  const paths = new Set<string>();
  for (const checkpoint of checkpoints) {
    for (const file of checkpoint.files ?? []) {
      if (file.path) paths.add(file.path);
    }
    for (const touched of checkpoint.agentTouchedPaths ?? []) {
      if (touched) paths.add(touched);
    }
    for (const turnFile of checkpoint.turnFiles ?? []) {
      if (turnFile.path) paths.add(turnFile.path);
    }
  }
  return [...paths].toSorted();
}

/**
 * Selects the next runnable gate in deterministic plan order: the first
 * required pending gate whose earlier required gates all passed (or were
 * not required). Gates left in any other status — including `interrupted`
 * after a resume that did not reset them — block selection.
 */
export function selectNextRunnableGate(
  gates: ReadonlyArray<ValidationGate>,
): ValidationGate | undefined {
  return gates.find((gate, index) => {
    if (!gate.required || gate.status !== "pending") return false;
    for (let i = 0; i < index; i += 1) {
      const earlier = gates[i];
      if (!earlier) continue;
      if (!earlier.required) continue;
      if (earlier.status !== "passed" && earlier.status !== "not-required") return false;
    }
    return true;
  });
}
