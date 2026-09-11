import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createReviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    diffPreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:diff-preview",
      tag: WS_METHODS.reviewGetDiffPreview,
      staleTimeMs: 5_000,
    }),
    openPullRequests: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:open-pull-requests",
      tag: WS_METHODS.gitListOpenPullRequests,
      staleTimeMs: 5_000,
    }),
    prewarmChangesContext: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:prewarm-changes-context",
      tag: WS_METHODS.gitPrewarmReviewChangesContext,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.cwd}:${input.scope}:${input.pullRequestNumber ?? ""}`,
      },
    }),
    runWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:run-workflow",
      tag: WS_METHODS.workflowRun,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.idempotencyKey}`,
      },
    }),
  };
}
