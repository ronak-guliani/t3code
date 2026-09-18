import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { ExecutionEnvironmentDescriptor, type ValidationTarget } from "@t3tools/contracts";
import { Schema } from "effect";

export type ValidationEnvironmentErrorCode =
  | "state-directory-required"
  | "state-read-failed"
  | "launch-failed"
  | "startup-timeout"
  | "partial-startup"
  | "early-exit"
  | "descriptor-mismatch"
  | "non-t3-html"
  | "wrong-origin"
  | "impostor-listener"
  | "pid-reuse"
  | "ambiguous-ownership"
  | "adoption-failed"
  | "cleanup-ambiguous"
  | "cleanup-failed";

export type ValidationEnvironmentRole = "backend" | "web";

export class ValidationEnvironmentError extends Error {
  readonly code: ValidationEnvironmentErrorCode;
  readonly role: ValidationEnvironmentRole | undefined;
  readonly diagnostics: ReadonlyArray<string>;

  constructor(
    code: ValidationEnvironmentErrorCode,
    message: string,
    options: {
      readonly role?: ValidationEnvironmentRole;
      readonly diagnostics?: ReadonlyArray<string>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ValidationEnvironmentError";
    this.code = code;
    this.role = options.role;
    this.diagnostics = options.diagnostics ?? [];
  }
}

export interface ValidationEnvironmentLaunchConfig {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ValidationEnvironmentTarget extends ValidationTarget {
  readonly stateDirectory: string;
  readonly launchConfig: ValidationEnvironmentLaunchConfig;
}

export interface ValidationEnvironmentProcessIdentity {
  readonly pid: number;
  readonly startIdentity: string;
  readonly ownershipIdentity: string;
}

export interface ValidationEnvironmentEndpoint {
  readonly origin: string;
  readonly port: number;
  readonly process: ValidationEnvironmentProcessIdentity;
}

export interface ValidationEnvironmentLease {
  readonly target: ValidationEnvironmentTarget;
  readonly environmentIdentity: string;
  readonly backend: ValidationEnvironmentEndpoint;
  readonly web: ValidationEnvironmentEndpoint;
  readonly backendOrigin: string;
  readonly webOrigin: string;
  readonly backendPort: number;
  readonly webPort: number;
  readonly stateDirectory: string;
  readonly ownershipIdentity: string;
  readonly release: () => Promise<void>;
}

export interface ValidationEnvironmentHttpResponse {
  readonly status: number;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly text?: string;
  readonly json?: unknown;
}

export interface ValidationEnvironmentAdapters {
  readonly state: {
    readonly read: (stateDirectory: string) => Promise<StoredValidationEnvironment | null>;
    readonly write: (record: StoredValidationEnvironment) => Promise<void>;
    readonly removeIfOwned: (stateDirectory: string, ownershipIdentity: string) => Promise<boolean>;
    readonly recordDiagnostic: (
      stateDirectory: string,
      ownershipIdentity: string,
      diagnostic: string,
    ) => Promise<void>;
  };
  readonly launcher: {
    readonly start: (input: {
      readonly target: ValidationEnvironmentTarget;
      readonly ownershipIdentity: string;
    }) => Promise<StartedValidationEnvironment>;
  };
  readonly process: {
    readonly inspect: (
      identity: ValidationEnvironmentProcessIdentity,
    ) => Promise<ValidationEnvironmentProcessIdentity | null>;
    readonly terminate: (identity: ValidationEnvironmentProcessIdentity) => Promise<void>;
  };
  readonly listener: {
    readonly inspect: (
      endpoint: ValidationEnvironmentEndpoint,
    ) => Promise<ValidationEnvironmentProcessIdentity | null>;
  };
  readonly http: {
    readonly request: (input: {
      readonly origin: string;
      readonly path: string;
      readonly signal: AbortSignal;
    }) => Promise<ValidationEnvironmentHttpResponse>;
  };
  readonly adopter: {
    readonly adopt: (lease: ValidationEnvironmentLease) => Promise<void>;
  };
}

export interface StartedValidationEnvironment {
  readonly ownershipIdentity: string;
  readonly backend: ValidationEnvironmentEndpoint;
  readonly web: ValidationEnvironmentEndpoint;
}

export interface StoredValidationEnvironment {
  readonly version: 1;
  readonly target: ValidationEnvironmentTarget;
  readonly ownershipIdentity: string;
  readonly backend: ValidationEnvironmentEndpoint;
  readonly web: ValidationEnvironmentEndpoint;
  readonly lastDiagnostic?: string;
}

export interface ValidationEnvironmentManagerOptions {
  readonly readinessTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

const endpointRoles = ["backend", "web"] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function targetEquals(
  left: ValidationEnvironmentTarget,
  right: ValidationEnvironmentTarget,
): boolean {
  return (
    left.workspaceRoot === right.workspaceRoot &&
    left.worktreePath === right.worktreePath &&
    left.branch === right.branch &&
    left.revision === right.revision &&
    left.dirtyStateFingerprint === right.dirtyStateFingerprint &&
    left.environmentIdentity === right.environmentIdentity &&
    left.stateDirectory === right.stateDirectory &&
    stableJson(left.launchConfig) === stableJson(right.launchConfig)
  );
}

function portFromOrigin(origin: string, role: ValidationEnvironmentRole): number {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch (cause) {
    throw new ValidationEnvironmentError("wrong-origin", `${role} origin is not a valid URL.`, {
      role,
      cause,
    });
  }

  if (
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)
  ) {
    throw new ValidationEnvironmentError(
      "wrong-origin",
      `${role} origin must be an exact loopback HTTP origin.`,
      { role },
    );
  }

  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ValidationEnvironmentError("wrong-origin", `${role} origin has no valid port.`, {
      role,
    });
  }
  return port;
}

function validateProcessIdentity(
  identity: ValidationEnvironmentProcessIdentity,
  role: ValidationEnvironmentRole,
): void {
  if (
    !Number.isInteger(identity.pid) ||
    identity.pid <= 0 ||
    !identity.startIdentity ||
    !identity.ownershipIdentity
  ) {
    throw new ValidationEnvironmentError(
      "ambiguous-ownership",
      `${role} process ownership metadata is incomplete.`,
      { role },
    );
  }
}

function validateEndpoint(
  endpoint: ValidationEnvironmentEndpoint,
  role: ValidationEnvironmentRole,
): ValidationEnvironmentEndpoint {
  const port = portFromOrigin(endpoint.origin, role);
  validateProcessIdentity(endpoint.process, role);
  if (endpoint.port !== port) {
    throw new ValidationEnvironmentError(
      "wrong-origin",
      `${role} bound port does not match its origin.`,
      { role },
    );
  }
  return { ...endpoint, origin: new URL(endpoint.origin).origin, port };
}

function errorFromUnknown(
  code: ValidationEnvironmentErrorCode,
  message: string,
  cause: unknown,
  role?: ValidationEnvironmentRole,
): ValidationEnvironmentError {
  if (cause instanceof ValidationEnvironmentError) return cause;
  return new ValidationEnvironmentError(code, message, {
    ...(role === undefined ? {} : { role }),
    cause,
  });
}

function isFatalStartupError(error: unknown): boolean {
  return (
    error instanceof ValidationEnvironmentError &&
    [
      "early-exit",
      "descriptor-mismatch",
      "non-t3-html",
      "wrong-origin",
      "impostor-listener",
      "pid-reuse",
      "ambiguous-ownership",
    ].includes(error.code)
  );
}

function expectedT3WebApp(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /<title>\s*t3 code(?:\s*\([^<]*\))?\s*<\/title>/.test(normalized) &&
    /id=["']root["']/.test(normalized) &&
    (/aria-label=["']t3 code splash screen["']/.test(normalized) ||
      /<script[^>]+type=["']module["'][^>]+src=["'][^"']+["']/.test(normalized))
  );
}

async function withTimeout<A>(promise: Promise<A>, timeoutMs: number, message: string): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<A>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createError(
  error: ValidationEnvironmentError,
  diagnostics: ReadonlyArray<string>,
): ValidationEnvironmentError {
  return new ValidationEnvironmentError(error.code, error.message, {
    ...(error.role === undefined ? {} : { role: error.role }),
    diagnostics: [...error.diagnostics, ...diagnostics],
    cause: error,
  });
}

export function createValidationEnvironmentManager(
  adapters: ValidationEnvironmentAdapters,
  options: ValidationEnvironmentManagerOptions = {},
): {
  readonly acquire: (target: ValidationEnvironmentTarget) => Promise<ValidationEnvironmentLease>;
} {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const locks = new Map<string, Promise<void>>();
  const active = new Map<
    string,
    {
      readonly key: string;
      readonly lease: Omit<ValidationEnvironmentLease, "release">;
      readonly record: StoredValidationEnvironment;
      references: number;
    }
  >();

  const withTargetLock = async <A>(key: string, operation: () => Promise<A>): Promise<A> => {
    const previous = locks.get(key) ?? Promise.resolve();
    let releaseLock!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const queued = previous.then(() => current);
    locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      releaseLock();
      if (locks.get(key) === queued) locks.delete(key);
    }
  };

  const recordDiagnostic = async (
    record: StoredValidationEnvironment,
    diagnostic: string,
  ): Promise<void> => {
    await adapters.state.recordDiagnostic(
      record.target.stateDirectory,
      record.ownershipIdentity,
      diagnostic,
    );
  };

  const inspectOwnedProcess = async (
    identity: ValidationEnvironmentProcessIdentity,
    role: ValidationEnvironmentRole,
  ): Promise<void> => {
    let current: ValidationEnvironmentProcessIdentity | null;
    try {
      current = await adapters.process.inspect(identity);
    } catch (cause) {
      throw new ValidationEnvironmentError(
        "ambiguous-ownership",
        `${role} process ownership could not be verified.`,
        { role, cause },
      );
    }
    if (current === null) {
      throw new ValidationEnvironmentError(
        "early-exit",
        `${role} process exited before environment readiness was verified.`,
        { role },
      );
    }
    if (current.pid !== identity.pid || current.startIdentity !== identity.startIdentity) {
      throw new ValidationEnvironmentError(
        "pid-reuse",
        `${role} PID was reused by another process.`,
        { role },
      );
    }
    if (current.ownershipIdentity !== identity.ownershipIdentity) {
      throw new ValidationEnvironmentError(
        "ambiguous-ownership",
        `${role} process ownership identity changed.`,
        { role },
      );
    }
  };

  const inspectOwnedListener = async (
    endpoint: ValidationEnvironmentEndpoint,
    role: ValidationEnvironmentRole,
  ): Promise<void> => {
    let listener: ValidationEnvironmentProcessIdentity | null;
    try {
      listener = await adapters.listener.inspect(endpoint);
    } catch (cause) {
      throw new ValidationEnvironmentError(
        "ambiguous-ownership",
        `${role} listener ownership could not be verified.`,
        { role, cause },
      );
    }
    if (listener === null) {
      throw new ValidationEnvironmentError(
        "impostor-listener",
        `${role} origin is not backed by an identifiable owned listener.`,
        { role },
      );
    }
    if (
      listener.pid !== endpoint.process.pid ||
      listener.startIdentity !== endpoint.process.startIdentity
    ) {
      throw new ValidationEnvironmentError(
        "impostor-listener",
        `${role} origin is backed by a different process.`,
        { role },
      );
    }
    if (listener.ownershipIdentity !== endpoint.process.ownershipIdentity) {
      throw new ValidationEnvironmentError(
        "ambiguous-ownership",
        `${role} listener ownership identity does not match the environment.`,
        { role },
      );
    }
  };

  const request = async (
    endpoint: ValidationEnvironmentEndpoint,
    role: ValidationEnvironmentRole,
    path: string,
  ): Promise<ValidationEnvironmentHttpResponse> => {
    const controller = new AbortController();
    try {
      const response = await withTimeout(
        adapters.http.request({ origin: endpoint.origin, path, signal: controller.signal }),
        requestTimeoutMs,
        `${role} readiness request timed out.`,
      );
      const expectedOrigin = new URL(endpoint.origin).origin;
      let responseOrigin: string;
      try {
        responseOrigin = new URL(response.url).origin;
      } catch (cause) {
        throw new ValidationEnvironmentError(
          "wrong-origin",
          `${role} readiness response URL is invalid.`,
          { role, cause },
        );
      }
      if (responseOrigin !== expectedOrigin) {
        throw new ValidationEnvironmentError(
          "wrong-origin",
          `${role} readiness response came from the wrong origin.`,
          { role },
        );
      }
      return response;
    } catch (cause) {
      controller.abort();
      if (cause instanceof ValidationEnvironmentError) throw cause;
      throw new ValidationEnvironmentError("startup-timeout", `${role} readiness probe failed.`, {
        role,
        cause,
      });
    }
  };

  const waitForReady = async (
    endpoint: ValidationEnvironmentEndpoint,
    role: ValidationEnvironmentRole,
    expectedEnvironmentIdentity: string,
  ): Promise<void> => {
    const deadline = now() + readinessTimeoutMs;
    let lastFailure: unknown;
    while (now() <= deadline) {
      try {
        await inspectOwnedProcess(endpoint.process, role);
        const response = await request(
          endpoint,
          role,
          role === "backend" ? "/.well-known/t3/environment" : "/",
        );
        if (response.status < 200 || response.status >= 300) {
          throw new ValidationEnvironmentError(
            "startup-timeout",
            `${role} readiness returned HTTP ${response.status}.`,
            { role },
          );
        }

        if (role === "backend") {
          let descriptor: typeof ExecutionEnvironmentDescriptor.Type;
          try {
            const body =
              response.json ??
              (response.text === undefined ? undefined : JSON.parse(response.text));
            descriptor = decodeDescriptor(body);
          } catch (cause) {
            throw new ValidationEnvironmentError(
              "descriptor-mismatch",
              "Backend readiness did not return a valid T3 environment descriptor.",
              { role, cause },
            );
          }
          if (descriptor.environmentId !== expectedEnvironmentIdentity) {
            throw new ValidationEnvironmentError(
              "descriptor-mismatch",
              "Backend descriptor environment identity does not match the requested environment.",
              { role },
            );
          }
        } else if (response.text === undefined || !expectedT3WebApp(response.text)) {
          throw new ValidationEnvironmentError(
            "non-t3-html",
            "Web origin did not serve the expected T3 web application.",
            { role },
          );
        }
        await inspectOwnedListener(endpoint, role);
        return;
      } catch (error) {
        if (isFatalStartupError(error)) throw error;
        lastFailure = error;
      }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollIntervalMs, remaining));
    }
    throw new ValidationEnvironmentError(
      "startup-timeout",
      `${role} environment readiness timed out.`,
      {
        role,
        diagnostics: [lastFailure instanceof Error ? lastFailure.message : String(lastFailure)],
      },
    );
  };

  const validateAndWait = async (
    endpoints: {
      readonly backend: ValidationEnvironmentEndpoint;
      readonly web: ValidationEnvironmentEndpoint;
    },
    expectedEnvironmentIdentity: string,
  ): Promise<void> => {
    const results = await Promise.allSettled([
      waitForReady(endpoints.backend, "backend", expectedEnvironmentIdentity),
      waitForReady(endpoints.web, "web", expectedEnvironmentIdentity),
    ]);
    const failures = results
      .map((result) => (result.status === "rejected" ? result.reason : undefined))
      .filter((value): value is unknown => value !== undefined);
    if (failures.length === 0) return;

    const fatal = failures.find(isFatalStartupError);
    if (fatal instanceof ValidationEnvironmentError) throw fatal;
    const readyCount = results.filter((result) => result.status === "fulfilled").length;
    const first = failures[0];
    if (readyCount > 0) {
      throw new ValidationEnvironmentError(
        "partial-startup",
        "Only part of the isolated environment became ready.",
        {
          diagnostics: failures.map((failure) =>
            failure instanceof Error ? failure.message : String(failure),
          ),
          cause: first,
        },
      );
    }
    if (first instanceof ValidationEnvironmentError) throw first;
    throw new ValidationEnvironmentError("startup-timeout", "Environment readiness timed out.", {
      cause: first,
    });
  };

  const cleanupOwned = async (
    record: StoredValidationEnvironment,
    options: { readonly removeState: boolean },
  ): Promise<void> => {
    const failures: string[] = [];
    for (const role of endpointRoles) {
      const endpoint = record[role];
      try {
        const current = await adapters.process.inspect(endpoint.process);
        if (current === null) continue;
        if (
          current.pid !== endpoint.process.pid ||
          current.startIdentity !== endpoint.process.startIdentity
        ) {
          throw new ValidationEnvironmentError(
            "cleanup-ambiguous",
            `${role} process identity changed; refusing to terminate it.`,
            { role },
          );
        }
        if (current.ownershipIdentity !== endpoint.process.ownershipIdentity) {
          throw new ValidationEnvironmentError(
            "cleanup-ambiguous",
            `${role} process ownership changed; refusing to terminate it.`,
            { role },
          );
        }
        await adapters.process.terminate(endpoint.process);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (failures.length > 0) {
      const diagnostic = failures.join(" | ");
      await recordDiagnostic(record, diagnostic).catch(() => undefined);
      throw new ValidationEnvironmentError("cleanup-ambiguous", diagnostic, {
        diagnostics: failures,
      });
    }

    if (options.removeState) {
      const removed = await adapters.state.removeIfOwned(
        record.target.stateDirectory,
        record.ownershipIdentity,
      );
      if (!removed) {
        const diagnostic = "Environment state ownership changed during cleanup.";
        await recordDiagnostic(record, diagnostic).catch(() => undefined);
        throw new ValidationEnvironmentError("cleanup-ambiguous", diagnostic);
      }
    }
  };

  const makeLease = (
    key: string,
    record: StoredValidationEnvironment,
    references: number,
  ): {
    readonly entry: {
      readonly key: string;
      readonly lease: Omit<ValidationEnvironmentLease, "release">;
      readonly record: StoredValidationEnvironment;
      references: number;
    };
    readonly retain: () => ValidationEnvironmentLease;
  } => {
    const entry = {
      key,
      record,
      references,
      lease: {
        target: record.target,
        environmentIdentity: record.target.environmentIdentity,
        backend: record.backend,
        web: record.web,
        backendOrigin: record.backend.origin,
        webOrigin: record.web.origin,
        backendPort: record.backend.port,
        webPort: record.web.port,
        stateDirectory: record.target.stateDirectory,
        ownershipIdentity: record.ownershipIdentity,
      },
    };
    const leaseForEntry = (): ValidationEnvironmentLease => {
      let released = false;
      return {
        ...entry.lease,
        release: async () => {
          if (released) return;
          released = true;
          await withTargetLock(key, async () => {
            if (entry.references > 0) entry.references -= 1;
            if (entry.references !== 0 || active.get(key) !== entry) return;
            active.delete(key);
            await cleanupOwned(entry.record, { removeState: true });
          });
        },
      };
    };
    const retain = (): ValidationEnvironmentLease => {
      return leaseForEntry();
    };
    return { entry, retain };
  };

  const acquire = async (
    target: ValidationEnvironmentTarget,
  ): Promise<ValidationEnvironmentLease> => {
    if (
      !target ||
      typeof target.stateDirectory !== "string" ||
      !target.stateDirectory.trim() ||
      !isAbsolute(target.stateDirectory)
    ) {
      throw new ValidationEnvironmentError(
        "state-directory-required",
        "Validation environment acquisition requires an explicit absolute state directory.",
      );
    }
    const key = stableJson(target);
    return withTargetLock(key, async () => {
      const existing = active.get(key);
      if (existing) {
        existing.references += 1;
        let released = false;
        const lease = {
          ...existing.lease,
          release: async () => {
            if (released) return;
            released = true;
            await withTargetLock(key, async () => {
              if (existing.references > 0) existing.references -= 1;
              if (existing.references !== 0 || active.get(key) !== existing) return;
              active.delete(key);
              await cleanupOwned(existing.record, { removeState: true });
            });
          },
        } satisfies ValidationEnvironmentLease;
        try {
          await adapters.adopter.adopt(lease);
        } catch (cause) {
          existing.references -= 1;
          throw new ValidationEnvironmentError(
            "adoption-failed",
            "Coordinator could not adopt the reused environment.",
            { cause },
          );
        }
        return lease;
      }

      let persisted: StoredValidationEnvironment | null;
      try {
        persisted = await adapters.state.read(target.stateDirectory);
      } catch (cause) {
        throw new ValidationEnvironmentError(
          "state-read-failed",
          "Validation environment state could not be read.",
          { cause },
        );
      }

      let record: StoredValidationEnvironment;
      const persistedRecord = persisted
        ? {
            ...persisted,
            backend: validateEndpoint(persisted.backend, "backend"),
            web: validateEndpoint(persisted.web, "web"),
          }
        : null;
      if (persistedRecord && persistedRecord.target.stateDirectory !== target.stateDirectory) {
        throw new ValidationEnvironmentError(
          "ambiguous-ownership",
          "Persisted environment state directory does not match the requested state directory.",
        );
      }
      if (persistedRecord && targetEquals(persistedRecord.target, target)) {
        record = persistedRecord;
        if (
          record.backend.process.ownershipIdentity !== record.ownershipIdentity ||
          record.web.process.ownershipIdentity !== record.ownershipIdentity
        ) {
          throw new ValidationEnvironmentError(
            "ambiguous-ownership",
            "Persisted environment ownership identities do not agree.",
          );
        }
        await validateAndWait(record, target.environmentIdentity);
      } else {
        if (persistedRecord) {
          await cleanupOwned(persistedRecord, { removeState: true });
        }
        const ownershipIdentity = `${target.environmentIdentity}:${randomUUID()}`;
        let started: StartedValidationEnvironment;
        try {
          started = await adapters.launcher.start({ target, ownershipIdentity });
        } catch (cause) {
          throw errorFromUnknown("launch-failed", "Validation environment launch failed.", cause);
        }
        try {
          if (started.ownershipIdentity !== ownershipIdentity) {
            throw new ValidationEnvironmentError(
              "ambiguous-ownership",
              "Launcher returned a different ownership identity.",
            );
          }
          record = {
            version: 1,
            target,
            ownershipIdentity,
            backend: validateEndpoint(started.backend, "backend"),
            web: validateEndpoint(started.web, "web"),
          };
          if (
            record.backend.process.ownershipIdentity !== ownershipIdentity ||
            record.web.process.ownershipIdentity !== ownershipIdentity
          ) {
            throw new ValidationEnvironmentError(
              "ambiguous-ownership",
              "Launched process ownership identities do not agree.",
            );
          }
          await validateAndWait(record, target.environmentIdentity);
          await adapters.state.write(record);
        } catch (cause) {
          try {
            await cleanupOwned(
              {
                version: 1,
                target,
                ownershipIdentity,
                backend: started.backend,
                web: started.web,
              },
              { removeState: false },
            );
          } catch (cleanupError) {
            if (cause instanceof ValidationEnvironmentError) {
              throw createError(cause, [
                cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              ]);
            }
            throw cleanupError;
          }
          if (cause instanceof ValidationEnvironmentError) throw cause;
          throw errorFromUnknown("launch-failed", "Validation environment startup failed.", cause);
        }
      }

      const created = makeLease(key, record, 1);
      active.set(key, created.entry);
      const lease = created.retain();
      try {
        await adapters.adopter.adopt(lease);
      } catch (cause) {
        active.delete(key);
        try {
          await cleanupOwned(record, { removeState: true });
        } catch (cleanupError) {
          throw new ValidationEnvironmentError(
            "adoption-failed",
            "Coordinator adoption failed and environment cleanup was ambiguous.",
            { cause: cleanupError, diagnostics: [String(cause)] },
          );
        }
        throw new ValidationEnvironmentError(
          "adoption-failed",
          "Coordinator could not adopt the validated environment.",
          { cause },
        );
      }
      return lease;
    });
  };

  return { acquire };
}
