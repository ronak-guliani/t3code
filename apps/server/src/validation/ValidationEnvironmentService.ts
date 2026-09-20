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
  type ValidationEnvironmentProcessIdentity,
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
const MAX_VALIDATION_RESPONSE_BYTES = 256 * 1024;

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
  const stateLocks = new Map<string, Promise<void>>();
  const knownProcesses = new Map<string, ValidationEnvironmentProcessIdentity | null>();
  const knownListeners = new Map<string, ValidationEnvironmentProcessIdentity | null>();

  const withStateLock = async <A>(
    stateDirectory: string,
    operation: () => Promise<A>,
  ): Promise<A> => {
    const previous = stateLocks.get(stateDirectory) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    stateLocks.set(stateDirectory, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (stateLocks.get(stateDirectory) === queued) stateLocks.delete(stateDirectory);
    }
  };

  const rememberRecord = (record: StoredValidationEnvironment): void => {
    const sameIdentity = (
      left: ValidationEnvironmentProcessIdentity,
      right: ValidationEnvironmentProcessIdentity,
    ): boolean =>
      left.pid === right.pid &&
      left.startIdentity === right.startIdentity &&
      left.ownershipIdentity === right.ownershipIdentity;
    for (const endpoint of [record.backend, record.web]) {
      const processKey = `${endpoint.process.pid}:${endpoint.process.startIdentity}`;
      const existingProcess = knownProcesses.get(processKey);
      knownProcesses.set(
        processKey,
        existingProcess === undefined ||
          (existingProcess !== null && sameIdentity(existingProcess, endpoint.process))
          ? endpoint.process
          : null,
      );
      const existingListener = knownListeners.get(endpoint.origin);
      knownListeners.set(
        endpoint.origin,
        existingListener === undefined ||
          (existingListener !== null && sameIdentity(existingListener, endpoint.process))
          ? endpoint.process
          : null,
      );
    }
  };

  const forgetRecord = (record: StoredValidationEnvironment): void => {
    for (const endpoint of [record.backend, record.web]) {
      const processKey = `${endpoint.process.pid}:${endpoint.process.startIdentity}`;
      const knownProcess = knownProcesses.get(processKey);
      if (knownProcess !== null && knownProcess?.ownershipIdentity === record.ownershipIdentity) {
        knownProcesses.delete(processKey);
      }
      const knownListener = knownListeners.get(endpoint.origin);
      if (knownListener !== null && knownListener?.ownershipIdentity === record.ownershipIdentity) {
        knownListeners.delete(endpoint.origin);
      }
    }
  };

  const readStateFile = async (
    stateDirectory: string,
  ): Promise<StoredValidationEnvironment | null> => {
    try {
      const raw = await readFile(join(stateDirectory, STATE_FILE), "utf8");
      const record = JSON.parse(raw) as StoredValidationEnvironment;
      rememberRecord(record);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
  };

  const readState = (stateDirectory: string): Promise<StoredValidationEnvironment | null> =>
    withStateLock(stateDirectory, () => readStateFile(stateDirectory));

  const writeStateFile = async (record: StoredValidationEnvironment): Promise<void> => {
    await mkdir(record.target.stateDirectory, { recursive: true });
    await writeFile(
      join(record.target.stateDirectory, STATE_FILE),
      JSON.stringify(record, null, 2),
      "utf8",
    );
    rememberRecord(record);
  };

  const writeState = (record: StoredValidationEnvironment): Promise<void> =>
    withStateLock(record.target.stateDirectory, () => writeStateFile(record));

  const adapters: ValidationEnvironmentAdapters = {
    state: {
      read: (stateDirectory) => readState(stateDirectory),
      write: (record) => writeState(record),
      removeIfOwned: (stateDirectory, ownershipIdentity) =>
        withStateLock(stateDirectory, async () => {
          const current = await readStateFile(stateDirectory);
          if (!current || current.ownershipIdentity !== ownershipIdentity) return false;
          try {
            await rm(join(stateDirectory, STATE_FILE), { force: true });
          } catch {
            return false;
          }
          forgetRecord(current);
          return true;
        }),
      recordDiagnostic: (stateDirectory, ownershipIdentity, diagnostic) =>
        withStateLock(stateDirectory, async () => {
          try {
            const current = await readStateFile(stateDirectory);
            if (!current || current.ownershipIdentity !== ownershipIdentity) return;
            await writeStateFile({ ...current, lastDiagnostic: diagnostic.slice(0, 1000) });
          } catch {
            return;
          }
        }),
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
        if (identity.pid !== process.pid || identity.startIdentity !== serverStartIdentity) {
          return null;
        }
        return knownProcesses.get(`${identity.pid}:${identity.startIdentity}`) ?? null;
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
        return knownListeners.get(endpoint.origin) ?? null;
      },
    },
    http: {
      request: async ({ origin, path, signal }) => {
        const url = `${origin}${path}`;
        const response = await fetch(url, { signal });
        const contentLength = response.headers.get("content-length");
        if (contentLength !== null && Number(contentLength) > MAX_VALIDATION_RESPONSE_BYTES) {
          throw new Error("Validation HTTP response exceeded the 256 KiB limit.");
        }
        const reader = response.body?.getReader();
        let text: string;
        if (!reader) {
          text = await response.text();
          if (Buffer.byteLength(text) > MAX_VALIDATION_RESPONSE_BYTES) {
            throw new Error("Validation HTTP response exceeded the 256 KiB limit.");
          }
        } else {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              totalBytes += value.byteLength;
              if (totalBytes > MAX_VALIDATION_RESPONSE_BYTES) {
                throw new Error("Validation HTTP response exceeded the 256 KiB limit.");
              }
              chunks.push(Buffer.from(value));
            }
          } finally {
            reader.releaseLock();
          }
          text = Buffer.concat(chunks).toString("utf8");
        }
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
