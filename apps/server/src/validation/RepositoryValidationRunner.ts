import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Cause, Clock, Context, Data, Effect, Layer, Semaphore } from "effect";

import * as ProcessRunner from "../processRunner.ts";

export type RepositoryValidationGateId =
  | "focused-tests"
  | "full-tests"
  | "format"
  | "lint"
  | "typecheck"
  | "pairing-self-test";

export type ValidationAttemptStatus = "passed" | "failed" | "interrupted";

export type ValidationFailureKind =
  | "invalid-spec"
  | "nonzero-exit"
  | "spawn-error"
  | "timeout"
  | "signal"
  | "cancelled"
  | "artifact-write-error";

export interface RepositoryValidationGateSpec {
  readonly id: RepositoryValidationGateId;
  readonly cwd: string;
  readonly attempt: number;
  readonly testFiles?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  /**
   * Optional caller-owned scope (for example a sanitized validation run id)
   * namespacing artifact keys so concurrent runs cannot overwrite each other.
   * Must already satisfy the artifact-key alphabet when provided.
   */
  readonly scope?: string;
}

export interface ValidationArtifactDescriptor {
  readonly key: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ValidationArtifactStore {
  readonly write: (input: {
    readonly key: string;
    readonly contents: string;
  }) => Effect.Effect<ValidationArtifactDescriptor, unknown>;
}

class ValidationArtifactWriteError extends Data.TaggedError("ValidationArtifactWriteError")<{
  readonly cause: unknown;
}> {}

export class ValidationArtifactStoreService extends Context.Service<
  ValidationArtifactStoreService,
  ValidationArtifactStore
>()("t3/validation/ValidationArtifactStore") {}

export interface ValidationExecutionDescriptor {
  readonly executable: "pnpm";
  readonly args: ReadonlyArray<string>;
}

export interface ValidationAttemptResult {
  readonly gateId: RepositoryValidationGateId;
  readonly attempt: number;
  readonly cwd: string;
  readonly command: ValidationExecutionDescriptor | null;
  readonly status: ValidationAttemptStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly artifact: ValidationArtifactDescriptor | null;
  readonly failure: {
    readonly kind: ValidationFailureKind;
    readonly message: string;
  } | null;
}

export interface RepositoryValidationRunInput {
  readonly gates: ReadonlyArray<RepositoryValidationGateSpec>;
}

export interface RepositoryValidationRunResult {
  readonly attempts: ReadonlyArray<ValidationAttemptResult>;
}

export interface RepositoryValidationRunnerShape {
  readonly run: (
    input: RepositoryValidationRunInput,
  ) => Effect.Effect<RepositoryValidationRunResult, never>;
}

export class RepositoryValidationRunner extends Context.Service<
  RepositoryValidationRunner,
  RepositoryValidationRunnerShape
>()("t3/validation/RepositoryValidationRunner") {}

const MAX_OUTPUT_BYTES = 256 * 1024;
const VALIDATION_PROCESS_CONCURRENCY = 4;
const validationProcesses = Semaphore.makeUnsafe(VALIDATION_PROCESS_CONCURRENCY);

function boundOutput(value: string): { readonly value: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= MAX_OUTPUT_BYTES) {
    return { value, truncated: false };
  }
  return {
    value: bytes.subarray(0, MAX_OUTPUT_BYTES).toString(),
    truncated: true,
  };
}

function commandFor(
  spec: RepositoryValidationGateSpec,
): ValidationExecutionDescriptor | { readonly failure: string } {
  switch (spec.id) {
    case "focused-tests":
      return {
        executable: "pnpm",
        args: ["exec", "vp", "test", "run", ...(spec.testFiles ?? [])],
      };
    case "full-tests":
      return { executable: "pnpm", args: ["test"] };
    case "format":
      return { executable: "pnpm", args: ["fmt:check"] };
    case "lint":
      return { executable: "pnpm", args: ["lint"] };
    case "typecheck":
      return { executable: "pnpm", args: ["typecheck"] };
    case "pairing-self-test":
      return { executable: "pnpm", args: ["test:self"] };
    default:
      return { failure: "This validation requirement is not executable by the repository runner." };
  }
}

function isSafeRelativeTestFile(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:/.test(normalized) &&
    !normalized.split("/").includes("..") &&
    !/[;&|`$<>]/.test(normalized)
  );
}

function validateSpec(spec: RepositoryValidationGateSpec): string | null {
  if (spec.cwd.trim().length === 0) return "cwd must not be empty.";
  if (!Number.isInteger(spec.attempt) || spec.attempt < 1) {
    return "attempt must be a positive integer.";
  }
  if (spec.timeoutMs !== undefined && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0)) {
    return "timeoutMs must be a positive finite number.";
  }
  if (spec.scope !== undefined && !isSafeArtifactKey(spec.scope)) {
    return "artifact scope must be a safe artifact key.";
  }
  if (
    spec.id === "focused-tests" &&
    spec.testFiles?.some((file) => !isSafeRelativeTestFile(file))
  ) {
    return "focused test files must be safe relative paths.";
  }
  return null;
}

function failureMessage(cause: Cause.Cause<unknown>): string {
  return Cause.pretty(cause);
}

function failureKind(cause: Cause.Cause<unknown>): ValidationFailureKind {
  if (Cause.hasInterruptsOnly(cause)) return "cancelled";
  return "spawn-error";
}

function artifactContents(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly failure: string | null;
}): string {
  return [
    result.failure ? `failure: ${result.failure}` : null,
    "----- stdout -----",
    result.stdout,
    "----- stderr -----",
    result.stderr,
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function isSafeArtifactKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key);
}

export function artifactKeyForSpec(spec: RepositoryValidationGateSpec): string {
  const base = `${spec.id}-attempt-${spec.attempt}`;
  return spec.scope === undefined ? base : `${spec.scope}-${base}`;
}

async function keepExistingTestFiles(cwd: string, files: ReadonlyArray<string>): Promise<string[]> {
  const kept: string[] = [];
  for (const file of files) {
    try {
      const entry = await stat(path.join(cwd, file));
      if (entry.isFile()) kept.push(file);
    } catch {
      // Renamed or deleted since planning: drop the candidate and let the
      // gate fall back to the bare suite rather than fail on a missing file.
    }
  }
  return kept;
}

export const makeFileValidationArtifactStore = (directory: string): ValidationArtifactStore => ({
  write: ({ key, contents }) => {
    if (!isSafeArtifactKey(key)) {
      return Effect.fail(
        new ValidationArtifactWriteError({
          cause: new Error(`Invalid artifact key: ${key}`),
        }),
      );
    }
    return Effect.tryPromise({
      try: async () => {
        await mkdir(directory, { recursive: true });
        const filePath = path.join(directory, `${key}.log`);
        await writeFile(filePath, contents, "utf8");
        const bytes = Buffer.byteLength(contents);
        return {
          key,
          path: filePath,
          bytes,
          sha256: createHash("sha256").update(contents).digest("hex"),
        };
      },
      catch: (cause) =>
        new ValidationArtifactWriteError({
          cause: cause instanceof Error ? cause : new Error(String(cause)),
        }),
    });
  },
});

export const makeRepositoryValidationRunner = Effect.fn("makeRepositoryValidationRunner")(
  function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const artifactStore = yield* ValidationArtifactStoreService;

    const runAttempt = (
      spec: RepositoryValidationGateSpec,
    ): Effect.Effect<ValidationAttemptResult, never> =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const specFailure = validateSpec(spec);
        const focusedTestFiles =
          specFailure === null && spec.id === "focused-tests" && spec.testFiles !== undefined
            ? yield* Effect.promise(() => keepExistingTestFiles(spec.cwd, spec.testFiles ?? []))
            : undefined;
        const effectiveSpec =
          focusedTestFiles === undefined ? spec : { ...spec, testFiles: focusedTestFiles };
        const commandResult = commandFor(effectiveSpec);
        if ("failure" in commandResult || specFailure !== null) {
          const failure =
            ("failure" in commandResult ? commandResult.failure : specFailure) ??
            "Validation gate specification is invalid.";
          const completedAt = yield* Clock.currentTimeMillis;
          return {
            gateId: spec.id,
            attempt: spec.attempt,
            cwd: spec.cwd,
            command: null,
            status: "failed",
            exitCode: null,
            signal: null,
            timedOut: false,
            cancelled: false,
            durationMs: Math.max(0, completedAt - startedAt),
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            artifact: null,
            failure: { kind: "invalid-spec", message: failure },
          } satisfies ValidationAttemptResult;
        }
        const command = commandResult;

        // Aborting here kills the spawned child when this fiber is
        // interrupted; without it the child would keep running past
        // cancellation until its own timeout.
        const abortController = new AbortController();
        const processExit = yield* Effect.uninterruptibleMask((restore) =>
          Effect.ensuring(
            restore(
              validationProcesses.withPermits(1)(
                processRunner.run({
                  command: command.executable,
                  args: command.args,
                  cwd: spec.cwd,
                  ...(spec.timeoutMs === undefined ? {} : { timeout: spec.timeoutMs }),
                  maxOutputBytes: MAX_OUTPUT_BYTES,
                  outputMode: "truncate",
                  signal: abortController.signal,
                }),
              ),
            ),
            Effect.sync(() => abortController.abort()),
          ).pipe(
            Effect.matchCause({
              onFailure: (cause) => ({ _tag: "failure" as const, cause }),
              onSuccess: (value) => ({ _tag: "success" as const, value }),
            }),
          ),
        );

        const completedAt = yield* Clock.currentTimeMillis;
        const durationMs = Math.max(0, completedAt - startedAt);
        const processResult =
          processExit._tag === "success"
            ? processExit.value
            : {
                stdout: "",
                stderr: "",
                code: null,
                signal: null,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
        const stdout = boundOutput(processResult.stdout);
        const stderr = boundOutput(processResult.stderr);
        const cancelled =
          processExit._tag === "failure" && Cause.hasInterruptsOnly(processExit.cause);
        const failure =
          processExit._tag === "failure"
            ? {
                kind: failureKind(processExit.cause),
                message: failureMessage(processExit.cause),
              }
            : processResult.timedOut
              ? { kind: "timeout" as const, message: "Validation timed out." }
              : processResult.signal
                ? {
                    kind: "signal" as const,
                    message: `Validation was terminated by ${processResult.signal}.`,
                  }
                : processResult.code !== 0
                  ? {
                      kind: "nonzero-exit" as const,
                      message: `Validation exited with code ${processResult.code ?? "null"}.`,
                    }
                  : null;

        const artifactKey = artifactKeyForSpec(spec);
        const artifactExit = yield* artifactStore
          .write({
            key: artifactKey,
            contents: artifactContents({
              stdout: stdout.value,
              stderr: stderr.value,
              failure: failure?.message ?? null,
            }),
          })
          .pipe(
            Effect.matchCause({
              onFailure: (cause) => ({ _tag: "failure" as const, cause }),
              onSuccess: (value) => ({ _tag: "success" as const, value }),
            }),
          );

        const artifactFailure =
          artifactExit._tag === "failure"
            ? {
                kind: "artifact-write-error" as const,
                message: failureMessage(artifactExit.cause),
              }
            : null;
        const finalFailure = artifactFailure ?? failure;
        const status: ValidationAttemptStatus =
          finalFailure === null
            ? "passed"
            : finalFailure.kind === "timeout" ||
                finalFailure.kind === "signal" ||
                finalFailure.kind === "cancelled"
              ? "interrupted"
              : "failed";

        return {
          gateId: spec.id,
          attempt: spec.attempt,
          cwd: spec.cwd,
          command,
          status,
          exitCode: processResult.code,
          signal: processResult.signal ?? null,
          timedOut: processResult.timedOut,
          cancelled,
          durationMs,
          stdout: stdout.value,
          stderr: stderr.value,
          stdoutTruncated: stdout.truncated || processResult.stdoutTruncated,
          stderrTruncated: stderr.truncated || processResult.stderrTruncated,
          artifact: artifactExit._tag === "success" ? artifactExit.value : null,
          failure: finalFailure,
        };
      });

    return {
      run: (input) =>
        Effect.forEach(input.gates, runAttempt, {
          concurrency: 1,
          discard: false,
        }).pipe(Effect.map((attempts) => ({ attempts }))),
    } satisfies RepositoryValidationRunnerShape;
  },
);

export const RepositoryValidationRunnerLive = Layer.effect(
  RepositoryValidationRunner,
  makeRepositoryValidationRunner(),
);
