import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import * as ProcessRunner from "../processRunner.ts";
import {
  artifactKeyForSpec,
  makeFileValidationArtifactStore,
  RepositoryValidationRunner,
  RepositoryValidationRunnerLive,
  ValidationArtifactStoreService,
  type RepositoryValidationGateSpec,
  type ValidationArtifactDescriptor,
  type ValidationArtifactStore,
} from "./RepositoryValidationRunner.ts";

type ProcessResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutInvalidUtf8: boolean;
  readonly stderrInvalidUtf8: boolean;
};

const descriptor = (key: string): ValidationArtifactDescriptor => ({
  key,
  path: `/artifacts/${key}.log`,
  bytes: 10,
  sha256: "hash",
});

const makeRunner = (
  run: (
    input: ProcessRunner.EffectProcessRunInput,
  ) => Effect.Effect<ProcessResult, ProcessRunner.ProcessSpawnError>,
  write: ValidationArtifactStore["write"] = ({ key }) => Effect.succeed(descriptor(key)),
) =>
  Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      const runner = yield* RepositoryValidationRunner;
      return yield* runner.run({
        gates: [
          {
            id: "lint",
            cwd: "/repo",
            attempt: 1,
          },
        ],
      });
    }).pipe(
      Effect.provide(RepositoryValidationRunnerLive),
      Effect.provideService(ProcessRunner.ProcessRunner, { run }),
      Effect.provideService(ValidationArtifactStoreService, { write }),
    );
    return result.attempts[0];
  });

const baseProcessResult = (): ProcessResult => ({
  stdout: "ok",
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

describe("RepositoryValidationRunner", () => {
  it("runs an allowlisted gate and returns bounded output plus an artifact", async () => {
    const result = await Effect.runPromise(makeRunner(() => Effect.succeed(baseProcessResult())));

    expect(result?.status).toBe("passed");
    expect(result?.command).toEqual({ executable: "pnpm", args: ["lint"] });
    expect(result?.artifact?.key).toBe("lint-attempt-1");
  });

  it("keeps nonzero exits as failed results", async () => {
    const result = await Effect.runPromise(
      makeRunner(() => Effect.succeed({ ...baseProcessResult(), code: 2, stderr: "bad" })),
    );

    expect(result?.status).toBe("failed");
    expect(result?.failure?.kind).toBe("nonzero-exit");
    expect(result?.exitCode).toBe(2);
  });

  it("reports spawn failures without throwing", async () => {
    const result = await Effect.runPromise(
      makeRunner(() =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "pnpm",
            argumentCount: 1,
            cause: new Error("missing"),
          }),
        ),
      ),
    );

    expect(result?.status).toBe("failed");
    expect(result?.failure?.kind).toBe("spawn-error");
    expect(result?.cancelled).toBe(false);
  });

  it("does not misclassify spawn errors mentioning interruption as cancelled", async () => {
    const result = await Effect.runPromise(
      makeRunner(() =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "pnpm",
            argumentCount: 1,
            cause: new Error("interrupted system call"),
          }),
        ),
      ),
    );

    expect(result?.status).toBe("failed");
    expect(result?.failure?.kind).toBe("spawn-error");
    expect(result?.cancelled).toBe(false);
  });

  it("reports timeouts, signals, and cancellation as interruptions", async () => {
    const timedOut = await Effect.runPromise(
      makeRunner(() => Effect.succeed({ ...baseProcessResult(), timedOut: true, code: null })),
    );
    expect(timedOut?.status).toBe("interrupted");
    expect(timedOut?.failure?.kind).toBe("timeout");

    const signaled = await Effect.runPromise(
      makeRunner(() => Effect.succeed({ ...baseProcessResult(), signal: "SIGTERM", code: null })),
    );
    expect(signaled?.status).toBe("interrupted");
    expect(signaled?.failure?.kind).toBe("signal");

    const cancelled = await Effect.runPromise(makeRunner(() => Effect.interrupt));
    expect(cancelled?.status).toBe("interrupted");
    expect(cancelled?.cancelled).toBe(true);
    expect(cancelled?.failure?.kind).toBe("cancelled");
  });

  it("bounds oversized output and surfaces artifact write failures", async () => {
    const oversized = "x".repeat(300_000);
    const bounded = await Effect.runPromise(
      makeRunner(() => Effect.succeed({ ...baseProcessResult(), stdout: oversized })),
    );
    expect(bounded?.stdout.length).toBeLessThanOrEqual(256 * 1024);
    expect(bounded?.stdoutTruncated).toBe(true);

    const artifactFailure = await Effect.runPromise(
      makeRunner(
        () => Effect.succeed(baseProcessResult()),
        () => Effect.fail(new Error("disk full")),
      ),
    );
    expect(artifactFailure?.status).toBe("failed");
    expect(artifactFailure?.failure?.kind).toBe("artifact-write-error");
    expect(artifactFailure?.artifact).toBeNull();
  });

  it("rejects arbitrary command-shaped input and preserves retry attempts", async () => {
    const run = vi.fn(() => Effect.succeed(baseProcessResult()));
    const invalid = {
      id: "lint",
      cwd: "/repo",
      attempt: 0,
      command: "rm -rf /",
    } as unknown as RepositoryValidationGateSpec;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* RepositoryValidationRunner;
        return yield* runner.run({
          gates: [
            invalid,
            { id: "lint", cwd: "/repo", attempt: 1 },
            { id: "lint", cwd: "/repo", attempt: 2 },
          ],
        });
      }).pipe(
        Effect.provide(RepositoryValidationRunnerLive),
        Effect.provideService(ProcessRunner.ProcessRunner, { run }),
        Effect.provideService(ValidationArtifactStoreService, {
          write: ({ key }) => Effect.succeed(descriptor(key)),
        }),
      ),
    );

    expect(result.attempts.map((attempt) => attempt.attempt)).toEqual([0, 1, 2]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.attempts[0]?.failure?.kind).toBe("invalid-spec");
  });

  it("does not execute browser validation", async () => {
    const run = vi.fn(() => Effect.succeed(baseProcessResult()));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* RepositoryValidationRunner;
        return yield* runner.run({
          gates: [
            {
              id: "browser-validation",
              cwd: "/repo",
              attempt: 1,
            } as never,
          ],
        });
      }).pipe(
        Effect.provide(RepositoryValidationRunnerLive),
        Effect.provideService(ProcessRunner.ProcessRunner, { run }),
        Effect.provideService(ValidationArtifactStoreService, {
          write: ({ key }) => Effect.succeed(descriptor(key)),
        }),
      ),
    );

    expect(run).not.toHaveBeenCalled();
    expect(result.attempts[0]?.failure?.kind).toBe("invalid-spec");
  });

  it("rejects Windows drive-absolute focused test files without executing", async () => {
    const run = vi.fn(() => Effect.succeed(baseProcessResult()));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* RepositoryValidationRunner;
        return yield* runner.run({
          gates: [
            {
              id: "focused-tests",
              cwd: "/repo",
              attempt: 1,
              testFiles: ["C:/evil/test.ts"],
            },
          ],
        });
      }).pipe(
        Effect.provide(RepositoryValidationRunnerLive),
        Effect.provideService(ProcessRunner.ProcessRunner, { run }),
        Effect.provideService(ValidationArtifactStoreService, {
          write: ({ key }) => Effect.succeed(descriptor(key)),
        }),
      ),
    );

    expect(run).not.toHaveBeenCalled();
    expect(result.attempts[0]?.failure?.kind).toBe("invalid-spec");
  });

  it("rejects unsafe artifact keys without writing outside the store", async () => {
    const store = makeFileValidationArtifactStore("/tmp/validation-artifacts-test");
    await expect(
      Effect.runPromise(store.write({ key: "../evil", contents: "x" })),
    ).rejects.toThrow();
  });

  it("scopes artifact keys per run so concurrent runs cannot overwrite each other", async () => {
    expect(artifactKeyForSpec({ id: "lint", cwd: "/repo", attempt: 1 })).toBe("lint-attempt-1");
    expect(
      artifactKeyForSpec({ id: "lint", cwd: "/repo", attempt: 2, scope: "validation-req-1" }),
    ).toBe("validation-req-1-lint-attempt-2");

    const written = new Map<string, string>();
    const store: ValidationArtifactStore = {
      write: ({ key, contents }) =>
        Effect.sync(() => {
          written.set(key, contents);
          return descriptor(key);
        }),
    };
    const run = vi.fn(() => Effect.succeed(baseProcessResult()));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* RepositoryValidationRunner;
        return yield* runner.run({
          gates: [
            { id: "lint", cwd: "/repo", attempt: 1, scope: "validation-req-1" },
            { id: "lint", cwd: "/repo", attempt: 1, scope: "validation-req-2" },
          ],
        });
      }).pipe(
        Effect.provide(RepositoryValidationRunnerLive),
        Effect.provideService(ProcessRunner.ProcessRunner, { run }),
        Effect.provideService(ValidationArtifactStoreService, store),
      ),
    );

    expect(result.attempts.map((attempt) => attempt.artifact?.key)).toEqual([
      "validation-req-1-lint-attempt-1",
      "validation-req-2-lint-attempt-1",
    ]);
    expect(written.size).toBe(2);
  });

  it("rejects unsafe artifact scopes without executing", async () => {
    const run = vi.fn(() => Effect.succeed(baseProcessResult()));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* RepositoryValidationRunner;
        return yield* runner.run({
          gates: [{ id: "lint", cwd: "/repo", attempt: 1, scope: "../../evil" }],
        });
      }).pipe(
        Effect.provide(RepositoryValidationRunnerLive),
        Effect.provideService(ProcessRunner.ProcessRunner, { run }),
        Effect.provideService(ValidationArtifactStoreService, {
          write: ({ key }) => Effect.succeed(descriptor(key)),
        }),
      ),
    );

    expect(run).not.toHaveBeenCalled();
    expect(result.attempts[0]?.failure?.kind).toBe("invalid-spec");
    expect(result.attempts[0]?.failure?.message).toContain("artifact scope");
  });
});
