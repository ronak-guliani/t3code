import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Context, Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import {
  createValidationEnvironmentManager,
  ValidationEnvironmentError,
  type StoredValidationEnvironment,
  type ValidationEnvironmentAdapters,
  type ValidationEnvironmentLease,
  type ValidationEnvironmentTarget,
} from "./ValidationEnvironmentManager.ts";

export interface ValidationEnvironmentServiceShape {
  readonly acquire: (
    target: import("@t3tools/contracts").ValidationTarget,
  ) => Effect.Effect<ValidationEnvironmentLease, ValidationEnvironmentError>;
}

export class ValidationEnvironmentService extends Context.Service<
  ValidationEnvironmentService,
  ValidationEnvironmentServiceShape
>()("t3/validation/ValidationEnvironmentService") {}

const STATE_FILE = "validation-environment.json";

// Captured once per process: process/pid-identity probes must observe the same
// start identity as the launch record, otherwise every readiness revalidation
// looks like PID reuse.
const serverStartIdentity = `pid:${process.pid}:start:${process.uptime().toFixed(3)}`;

function safeEnvId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "default";
}

export function validationEnvironmentStateDirectory(
  baseDir: string,
  target: import("@t3tools/contracts").ValidationTarget,
): string {
  const targetKey = createHash("sha256")
    .update(
      JSON.stringify([
        target.workspaceRoot,
        target.worktreePath,
        target.branch,
        target.revision,
        target.dirtyStateFingerprint,
        target.environmentIdentity,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  return join(baseDir, "validation", safeEnvId(target.environmentIdentity), targetKey);
}

export const makeValidationEnvironmentService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const environment = yield* ServerEnvironment;
  const currentEnvironmentId = yield* environment.getEnvironmentId;

  const readState = async (stateDirectory: string): Promise<StoredValidationEnvironment | null> => {
    try {
      const raw = await readFile(join(stateDirectory, STATE_FILE), "utf8");
      return JSON.parse(raw) as StoredValidationEnvironment;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
  };

  const writeState = async (record: StoredValidationEnvironment): Promise<void> => {
    await mkdir(record.target.stateDirectory, { recursive: true });
    await writeFile(
      join(record.target.stateDirectory, STATE_FILE),
      JSON.stringify(record, null, 2),
      "utf8",
    );
  };

  const adapters: ValidationEnvironmentAdapters = {
    state: {
      read: (stateDirectory) => readState(stateDirectory),
      write: (record) => writeState(record),
      removeIfOwned: async (stateDirectory, ownershipIdentity) => {
        const current = await readState(stateDirectory);
        if (!current || current.ownershipIdentity !== ownershipIdentity) return false;
        try {
          await rm(join(stateDirectory, STATE_FILE), { force: true });
        } catch {
          return false;
        }
        return true;
      },
      recordDiagnostic: async (stateDirectory, _ownershipIdentity, diagnostic) => {
        try {
          const current = await readState(stateDirectory);
          if (!current) return;
          await writeState({ ...current, lastDiagnostic: diagnostic.slice(0, 1000) });
        } catch {
          return;
        }
      },
    },
    launcher: {
      start: async ({ target }) => {
        throw new ValidationEnvironmentError(
          target.environmentIdentity !== currentEnvironmentId
            ? "descriptor-mismatch"
            : "launch-failed",
          "Launching the captured validation target is not available in this server process.",
        );
      },
    },
    process: {
      inspect: async (identity) => {
        if (identity.pid !== process.pid) return null;
        return {
          pid: process.pid,
          startIdentity: serverStartIdentity,
          ownershipIdentity: identity.ownershipIdentity,
        };
      },
      terminate: async (identity) => {
        if (identity.pid === process.pid) return;
        try {
          process.kill(identity.pid, "SIGTERM");
        } catch {
          return;
        }
      },
    },
    listener: {
      inspect: async (endpoint) => {
        if (endpoint.port !== config.port) return null;
        return {
          pid: process.pid,
          startIdentity: serverStartIdentity,
          ownershipIdentity: endpoint.process.ownershipIdentity,
        };
      },
    },
    http: {
      request: async ({ origin, path, signal }) => {
        const url = `${origin}${path}`;
        const response = await fetch(url, { signal });
        const text = await response.text();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        return {
          status: response.status,
          url: response.url || url,
          text,
          ...(json === undefined ? {} : { json }),
        };
      },
    },
    adopter: {
      adopt: async () => {},
    },
  };

  const manager = createValidationEnvironmentManager(adapters, {
    readinessTimeoutMs: 10_000,
    requestTimeoutMs: 2_000,
    pollIntervalMs: 100,
  });

  const toTarget = (
    target: import("@t3tools/contracts").ValidationTarget,
  ): ValidationEnvironmentTarget => ({
    ...target,
    stateDirectory: validationEnvironmentStateDirectory(config.baseDir, target),
    launchConfig: {
      command: "pnpm",
      args: ["dev"],
      cwd: target.worktreePath ?? target.workspaceRoot,
    },
  });

  return {
    acquire: (target) =>
      Effect.tryPromise({
        try: () => manager.acquire(toTarget(target)),
        catch: (cause) =>
          cause instanceof ValidationEnvironmentError
            ? cause
            : new ValidationEnvironmentError(
                "launch-failed",
                "Validation environment acquisition failed.",
                {
                  cause,
                },
              ),
      }),
  } satisfies ValidationEnvironmentServiceShape;
});

export const ValidationEnvironmentServiceLive = Layer.effect(
  ValidationEnvironmentService,
  makeValidationEnvironmentService,
);
