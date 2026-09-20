import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  BrowserValidationScenario,
  ValidationGate,
  ValidationGateKind,
  ValidationStructuredResult,
  ValidationTarget,
} from "@t3tools/contracts";
import { Context, Effect, Layer } from "effect";

import * as BootstrapCredentialService from "../auth/Services/BootstrapCredentialService.ts";
import { ServerConfig } from "../config.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import {
  executeBrowserValidation,
  type BrowserValidationExecutorDependencies,
} from "./BrowserValidationExecutor.ts";
import { redactBrowserValidationText } from "./BrowserValidationEvidence.ts";
import {
  RepositoryValidationRunner,
  type RepositoryValidationGateId,
} from "./RepositoryValidationRunner.ts";
import { ValidationEnvironmentService } from "./ValidationEnvironmentService.ts";

export type GateExecutionOutcome =
  | { readonly kind: "result"; readonly result: ValidationStructuredResult }
  | { readonly kind: "blocked"; readonly reason: string; readonly diagnostics: string[] }
  | { readonly kind: "interrupted"; readonly reason: string; readonly diagnostics: string[] };

const REPO_KINDS: ReadonlySet<string> = new Set([
  "focused-tests",
  "full-tests",
  "format",
  "lint",
  "typecheck",
  "pairing-self-test",
]);

export function isRepositoryGateKind(kind: ValidationGateKind | undefined): boolean {
  return kind !== undefined && REPO_KINDS.has(kind);
}

export function isBrowserGateKind(kind: ValidationGateKind | undefined): boolean {
  return kind === "browser-scenario" || kind === "browser-validation";
}

export function repositoryGateIdForKind(
  kind: ValidationGateKind | undefined,
): RepositoryValidationGateId | null {
  if (kind === "focused-tests") return "focused-tests";
  if (kind === "full-tests") return "full-tests";
  if (kind === "format") return "format";
  if (kind === "lint") return "lint";
  if (kind === "typecheck") return "typecheck";
  if (kind === "pairing-self-test") return "pairing-self-test";
  return null;
}

function redactText(value: string): string {
  const redacted = redactBrowserValidationText(value)
    .replace(
      /(credential|password|secret|session|authorization|access_token|token)\s*[:=]\s*[^\s;,]+/gi,
      "$1=[redacted]",
    )
    .replace(/([?#&](?:token|credential|secret|session)=)[^&#\s]+/gi, "$1[redacted]");
  return redacted.slice(0, 1000);
}

function boundedDiagnostics(values: ReadonlyArray<string>): string[] {
  return values.map((value) => redactText(value)).slice(0, 10);
}

function outputRefForArtifact(key: string, sha256: string): string {
  return `artifact:${key}:${sha256}`.slice(0, 200);
}

export function attemptNumberForAttemptId(attemptId: string): number {
  const match = /:(\d+)$/.exec(attemptId);
  const parsed = match?.[1] === undefined ? NaN : Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * Derives a filesystem-safe artifact scope from a coordinator run id so
 * repository evidence from concurrent runs cannot share artifact keys.
 * Request ids are UUIDs, so the sanitized form stays injective in practice.
 */
export function artifactScopeForRun(runId: string): string {
  const sanitized = runId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return (sanitized || "run").slice(0, 64);
}

export function mapRepositoryAttemptToResult(input: {
  readonly runId: string;
  readonly gate: ValidationGate;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly executorId: string;
  readonly target: ValidationTarget;
  readonly attempt: {
    readonly status: "passed" | "failed" | "interrupted";
    readonly exitCode: number | null;
    readonly artifact: { readonly key: string; readonly sha256: string } | null;
    readonly failure: { readonly kind: string; readonly message: string } | null;
    readonly stdout: string;
    readonly stderr: string;
  };
  readonly observedAt: string;
  readonly completedAt: string;
  readonly envIdentity?: string;
}): ValidationStructuredResult {
  const status =
    input.attempt.status === "passed"
      ? ("passed" as const)
      : input.attempt.status === "interrupted"
        ? ("interrupted" as const)
        : input.attempt.failure?.kind === "invalid-spec"
          ? ("blocked" as const)
          : ("failed" as const);
  const blockerReason =
    status === "blocked"
      ? (input.attempt.failure?.message.slice(0, 500) ?? "Invalid gate spec.")
      : null;
  const diagnostics: string[] = [];
  if (input.envIdentity) {
    diagnostics.push(`environment ${input.envIdentity}`);
  }
  if (input.attempt.failure) {
    diagnostics.push(redactText(`${input.attempt.failure.kind}: ${input.attempt.failure.message}`));
  }
  if (input.attempt.stdout) {
    diagnostics.push(redactText(`stdout: ${input.attempt.stdout.slice(0, 500)}`));
  }
  if (input.attempt.stderr) {
    diagnostics.push(redactText(`stderr: ${input.attempt.stderr.slice(0, 500)}`));
  }
  return {
    id: `result:${input.runId}:${input.gate.id}:${input.attemptId}`,
    runId: input.runId,
    gateId: input.gate.id,
    attemptId: input.attemptId,
    leaseId: input.leaseId,
    executorId: input.executorId,
    target: input.target,
    status,
    observedAt: input.observedAt,
    completedAt: input.completedAt,
    exitCode: input.attempt.exitCode,
    outputRef: input.attempt.artifact
      ? outputRefForArtifact(input.attempt.artifact.key, input.attempt.artifact.sha256)
      : null,
    blockerReason,
    diagnostics: boundedDiagnostics(diagnostics),
  };
}

export function browserScenarioForGate(input: {
  readonly gate: ValidationGate;
  readonly scenarioId: string;
  readonly webOrigin: string;
  readonly webPort: number;
}): BrowserValidationScenario {
  const label = input.gate.label || `Browser scenario: ${input.scenarioId}`;
  return {
    id: input.scenarioId,
    label,
    target: {
      kind: "environment-port",
      port: input.webPort,
      protocol: "http",
      path: "/",
    },
    authentication: {
      origin: input.webOrigin,
      requiredText: "T3",
    },
    actions: [],
    assertions: [
      { id: "app-title", kind: "title", expected: "T3" },
      { id: "app-loaded", kind: "not-loading" },
      { id: "app-text", kind: "visible-text", expected: "T3" },
    ],
    media: [{ kind: "screenshot", required: true }],
  };
}

export function mapBrowserResultToStructured(input: {
  readonly runId: string;
  readonly gate: ValidationGate;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly executorId: string;
  readonly target: ValidationTarget;
  readonly outcome: "passed" | "failed" | "blocked" | "interrupted";
  readonly evidence: {
    readonly media: ReadonlyArray<{
      readonly kind: string;
      readonly sha256: string;
      readonly persistedPath?: string | undefined;
    }>;
    readonly diagnostics: {
      readonly console: ReadonlyArray<{ readonly message: string }>;
      readonly network: ReadonlyArray<{ readonly message: string }>;
    };
    readonly assertions: ReadonlyArray<{
      readonly id: string;
      readonly passed: boolean;
      readonly observed: string;
    }>;
    readonly authentication: { readonly passed: boolean };
  };
  readonly diagnostics: ReadonlyArray<{ readonly message: string }>;
  readonly observedAt: string;
  readonly completedAt: string;
  readonly envSummary: string;
}): ValidationStructuredResult {
  const status =
    input.outcome === "passed"
      ? ("passed" as const)
      : input.outcome === "failed"
        ? ("failed" as const)
        : input.outcome === "interrupted"
          ? ("interrupted" as const)
          : ("blocked" as const);
  const mediaRefs = input.evidence.media
    .map((media) => `${media.kind}:${media.sha256.slice(0, 16)}`)
    .join(",");
  const extra: string[] = [];
  for (const entry of input.diagnostics) {
    extra.push(redactText(entry.message));
  }
  for (const assertion of input.evidence.assertions) {
    extra.push(redactText(`assertion ${assertion.id}: ${assertion.passed ? "passed" : "failed"}`));
  }
  if (!input.evidence.authentication.passed) {
    extra.push("authentication: not observed");
  }
  const diagnostics: string[] = [input.envSummary, ...extra];
  return {
    id: `result:${input.runId}:${input.gate.id}:${input.attemptId}`,
    runId: input.runId,
    gateId: input.gate.id,
    attemptId: input.attemptId,
    leaseId: input.leaseId,
    executorId: input.executorId,
    target: input.target,
    status,
    observedAt: input.observedAt,
    completedAt: input.completedAt,
    exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
    outputRef: mediaRefs ? `browser:${mediaRefs}`.slice(0, 200) : null,
    blockerReason:
      status === "blocked" ? (extra[0] ?? "Browser validation is blocked.").slice(0, 500) : null,
    diagnostics: boundedDiagnostics(diagnostics),
  };
}

export interface ValidationGateExecutorShape {
  readonly executeRepositoryGate: (input: {
    readonly runId: string;
    readonly gate: ValidationGate;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly executorId: string;
    readonly target: ValidationTarget;
    readonly cwd: string;
    readonly observedAt: string;
    readonly testFiles?: ReadonlyArray<string>;
  }) => Effect.Effect<ValidationStructuredResult, Error>;
  readonly executeBrowserGate: (input: {
    readonly runId: string;
    readonly gate: ValidationGate;
    readonly scenarioId: string;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly executorId: string;
    readonly target: ValidationTarget;
    readonly threadId: import("@t3tools/contracts").ThreadId;
    readonly observedAt: string;
  }) => Effect.Effect<ValidationStructuredResult, Error>;
}

export class ValidationGateExecutor extends Context.Service<
  ValidationGateExecutor,
  ValidationGateExecutorShape
>()("t3/validation/ValidationGateExecutor") {}

export function mediaFileNameForGate(input: {
  readonly gateId: string;
  readonly sha256: string;
  readonly kind: "screenshot" | "recording";
}): string {
  const segment = input.gateId.split(":").pop() ?? "";
  if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === "." || segment === "..") {
    throw new Error("Media filename derived from the gate is unsafe.");
  }
  const ext = input.kind === "screenshot" ? "png" : "webm";
  return `${segment}-${input.sha256.slice(0, 16)}.${ext}`;
}

export const makeFileMediaPersistence = (baseDir: string) => ({
  persist: async (input: {
    readonly identity: { readonly runId: string; readonly gateId: string };
    readonly kind: "screenshot" | "recording";
    readonly mimeType: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
  }): Promise<string> => {
    const dir = join(baseDir, "validation", artifactScopeForRun(input.identity.runId));
    await mkdir(dir, { recursive: true });
    const path = join(
      dir,
      mediaFileNameForGate({
        gateId: input.identity.gateId,
        sha256: input.sha256,
        kind: input.kind,
      }),
    );
    await writeFile(path, input.bytes);
    return path;
  },
});

export const makeValidationGateExecutor = Effect.gen(function* () {
  const repositoryRunner = yield* RepositoryValidationRunner;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const credentials = yield* BootstrapCredentialService.BootstrapCredentialService;
  const envService = yield* ValidationEnvironmentService;
  const config = yield* ServerConfig;

  const executeRepositoryGate: ValidationGateExecutorShape["executeRepositoryGate"] = (input) =>
    Effect.gen(function* () {
      const gateId = repositoryGateIdForKind(input.gate.kind);
      if (!gateId) {
        return yield* Effect.fail(
          new Error(`Repository gate kind ${input.gate.kind ?? "unknown"} is not executable.`),
        );
      }
      const completed = yield* repositoryRunner.run({
        gates: [
          {
            id: gateId,
            cwd: input.cwd,
            attempt: attemptNumberForAttemptId(input.attemptId),
            scope: artifactScopeForRun(input.runId),
            ...(input.testFiles === undefined ? {} : { testFiles: [...input.testFiles] }),
          },
        ],
      });
      const attempt = completed.attempts[0];
      if (!attempt) {
        return yield* Effect.fail(new Error("Repository runner returned no attempts."));
      }
      const completedAt = new Date().toISOString();
      return mapRepositoryAttemptToResult({
        runId: input.runId,
        gate: input.gate,
        attemptId: input.attemptId,
        leaseId: input.leaseId,
        executorId: input.executorId,
        target: input.target,
        attempt: {
          status: attempt.status,
          exitCode: attempt.exitCode,
          artifact: attempt.artifact,
          failure: attempt.failure,
          stdout: attempt.stdout,
          stderr: attempt.stderr,
        },
        observedAt: input.observedAt,
        completedAt,
        envIdentity: input.target.environmentIdentity,
      });
    });

  const executeBrowserGate: ValidationGateExecutorShape["executeBrowserGate"] = (input) =>
    Effect.gen(function* () {
      if (input.target.environmentIdentity.trim().length === 0) {
        return yield* Effect.fail(new Error("Validation target has no environment identity."));
      }
      const lease = yield* envService.acquire(input.target);
      try {
        if (lease.environmentIdentity !== input.target.environmentIdentity) {
          return yield* Effect.fail(
            new Error("The captured validation target does not match the environment."),
          );
        }
        const webOrigin = lease.webOrigin;
        const webPort = lease.webPort;
        const scenario = browserScenarioForGate({
          gate: input.gate,
          scenarioId: input.scenarioId,
          webOrigin,
          webPort,
        });
        if (
          scenario.media.some(
            (requirement) => requirement.kind === "recording" && requirement.required,
          )
        ) {
          const completedAt = new Date().toISOString();
          return {
            id: `result:${input.runId}:${input.gate.id}:${input.attemptId}`,
            runId: input.runId,
            gateId: input.gate.id,
            attemptId: input.attemptId,
            leaseId: input.leaseId,
            executorId: input.executorId,
            target: input.target,
            status: "blocked" as const,
            observedAt: input.observedAt,
            completedAt,
            exitCode: null,
            outputRef: null,
            blockerReason:
              "Recording-required scenarios are blocked until a verified recording decoder is available.",
            diagnostics: [
              `environment ${lease.environmentIdentity} backend ${lease.backendOrigin}:${lease.backendPort} pid ${lease.backend.process.pid} web ${lease.webOrigin}:${lease.webPort} pid ${lease.web.process.pid}`,
            ],
          } satisfies ValidationStructuredResult;
        }
        const environment = {
          environmentId: lease.environmentIdentity as import("@t3tools/contracts").EnvironmentId,
          label: "validation",
          platform: { os: "darwin" as const, arch: "arm64" as const },
          serverVersion: "validation",
          capabilities: { repositoryIdentity: true },
        };
        const dependencies: BrowserValidationExecutorDependencies = {
          broker,
          credentials,
          mediaPersistence: makeFileMediaPersistence(config.baseDir),
        };
        if (environment.environmentId !== input.target.environmentIdentity) {
          return yield* Effect.fail(
            new Error("The captured validation target does not match the environment."),
          );
        }
        const browserResult = yield* executeBrowserValidation(dependencies, {
          runId: input.runId,
          gateId: input.gate.id,
          executorId: input.executorId,
          target: input.target,
          environment,
          scenario,
          threadId: input.threadId,
        });
        const completedAt = new Date().toISOString();
        return mapBrowserResultToStructured({
          runId: input.runId,
          gate: input.gate,
          attemptId: input.attemptId,
          leaseId: input.leaseId,
          executorId: input.executorId,
          target: input.target,
          outcome: browserResult.outcome,
          evidence: {
            media: browserResult.evidence.media,
            diagnostics: browserResult.evidence.diagnostics,
            assertions: browserResult.evidence.assertions,
            authentication: browserResult.evidence.authentication,
          },
          diagnostics: browserResult.diagnostics,
          observedAt: input.observedAt,
          completedAt,
          envSummary: `environment ${lease.environmentIdentity} backend ${lease.backendOrigin}:${lease.backendPort} pid ${lease.backend.process.pid} web ${lease.webOrigin}:${lease.webPort} pid ${lease.web.process.pid}`,
        });
      } finally {
        yield* Effect.promise(() => lease.release()).pipe(Effect.ignore);
      }
    });

  return { executeRepositoryGate, executeBrowserGate } satisfies ValidationGateExecutorShape;
});

export const ValidationGateExecutorLive = Layer.effect(
  ValidationGateExecutor,
  makeValidationGateExecutor,
);
