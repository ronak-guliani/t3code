import type {
  ThreadId,
  ValidationRequester,
  ValidationRun,
  ValidationScenario,
  ValidationScope,
  ValidationTarget,
} from "@t3tools/contracts";
import { planValidationCoordinatorRun } from "@t3tools/client-runtime/validation-lifecycle";

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

export function planCoordinatorRunWithPolicy(input: ValidationPlannerInput): ValidationRun {
  const policy = new ValidationPolicy().classify({
    changedPaths: [...input.changedPaths],
    scope: input.scope,
  });
  return planValidationCoordinatorRun({
    id: input.id,
    requestId: input.requestId,
    threadId: input.threadId,
    target: input.target,
    scenarios: input.scenarios,
    scope: input.scope,
    requester: input.requester,
    requestedAt: input.requestedAt,
    requiredGateKinds: policy.requirements.map((requirement) => requirement.id),
  });
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
