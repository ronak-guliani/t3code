import { describe, expect, it } from "vitest";

import {
  createValidationEnvironmentManager,
  ValidationEnvironmentError,
  type StartedValidationEnvironment,
  type StoredValidationEnvironment,
  type ValidationEnvironmentAdapters,
  type ValidationEnvironmentLease,
  type ValidationEnvironmentProcessIdentity,
  type ValidationEnvironmentTarget,
} from "./ValidationEnvironmentManager.ts";

const target: ValidationEnvironmentTarget = {
  workspaceRoot: "/repo",
  worktreePath: "/repo/.worktrees/feature",
  branch: "feature",
  revision: "revision-1",
  dirtyStateFingerprint: "dirty-1",
  environmentIdentity: "environment-1",
  stateDirectory: "/tmp/t3-validation/environment-1",
  launchConfig: {
    command: "pnpm",
    args: ["dev"],
    cwd: "/repo",
    env: { T3CODE_MODE: "web" },
  },
};

const html = `<!doctype html><html><head><title>T3 Code (Alpha)</title></head><body>
  <div id="root"><div aria-label="T3 Code splash screen"></div></div>
</body></html>`;

function errorCode(error: unknown): string | undefined {
  return error instanceof ValidationEnvironmentError ? error.code : undefined;
}

function makeHarness(
  options: {
    readonly backendResponse?: () => Record<string, unknown>;
    readonly webText?: () => string;
    readonly responseUrl?: (origin: string, path: string) => string;
    readonly listenerIdentity?: (
      endpoint: StartedValidationEnvironment["backend"],
    ) => ValidationEnvironmentProcessIdentity | null;
    readonly processIdentity?: (
      identity: ValidationEnvironmentProcessIdentity,
    ) => ValidationEnvironmentProcessIdentity | null;
    readonly startDelayMs?: number;
    readonly requestDelayMs?: number;
    readonly backendStatus?: number;
    readonly webStatus?: number;
    readonly exitWebOnStart?: boolean;
  } = {},
) {
  const states = new Map<string, StoredValidationEnvironment>();
  let nextPid = 10_000;
  let launchCount = 0;
  let activeStarts = 0;
  let maxActiveStarts = 0;
  let adoptCount = 0;
  let terminateCount = 0;
  const processes = new Map<number, ValidationEnvironmentProcessIdentity>();
  const listeners = new Map<string, ValidationEnvironmentProcessIdentity>();
  const environmentIds = new Map<string, string>();
  const requests: string[] = [];
  const diagnostics: string[] = [];
  let processInspect = async (
    identity: ValidationEnvironmentProcessIdentity,
  ): Promise<ValidationEnvironmentProcessIdentity | null> =>
    options.processIdentity?.(identity) ?? processes.get(identity.pid) ?? null;

  const adapters: ValidationEnvironmentAdapters = {
    state: {
      read: async (stateDirectory) => states.get(stateDirectory) ?? null,
      write: async (record) => {
        states.set(record.target.stateDirectory, record);
      },
      removeIfOwned: async (stateDirectory, ownershipIdentity) => {
        const state = states.get(stateDirectory);
        if (state?.ownershipIdentity !== ownershipIdentity) return false;
        states.delete(stateDirectory);
        return true;
      },
      recordDiagnostic: async (_directory, _ownershipIdentity, diagnostic) => {
        diagnostics.push(diagnostic);
      },
    },
    launcher: {
      start: async ({ target: requestedTarget, ownershipIdentity }) => {
        launchCount += 1;
        activeStarts += 1;
        maxActiveStarts = Math.max(maxActiveStarts, activeStarts);
        if (options.startDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.startDelayMs));
        }
        activeStarts -= 1;
        const backendProcess = {
          pid: nextPid++,
          startIdentity: `start-${launchCount}-backend`,
          ownershipIdentity,
        };
        const webProcess = {
          pid: nextPid++,
          startIdentity: `start-${launchCount}-web`,
          ownershipIdentity,
        };
        const started: StartedValidationEnvironment = {
          ownershipIdentity,
          backend: {
            origin: `http://127.0.0.1:${4000 + launchCount * 2}`,
            port: 4000 + launchCount * 2,
            process: backendProcess,
          },
          web: {
            origin: `http://127.0.0.1:${4001 + launchCount * 2}`,
            port: 4001 + launchCount * 2,
            process: webProcess,
          },
        };
        processes.set(backendProcess.pid, backendProcess);
        processes.set(webProcess.pid, webProcess);
        listeners.set(started.backend.origin, backendProcess);
        listeners.set(started.web.origin, webProcess);
        if (options.exitWebOnStart) processes.delete(webProcess.pid);
        environmentIds.set(started.backend.origin, requestedTarget.environmentIdentity);
        environmentIds.set(started.web.origin, requestedTarget.environmentIdentity);
        return started;
      },
    },
    process: {
      inspect: (identity) => processInspect(identity),
      terminate: async (identity) => {
        terminateCount += 1;
        processes.delete(identity.pid);
        for (const [origin, listener] of listeners) {
          if (listener.pid === identity.pid) listeners.delete(origin);
        }
      },
    },
    listener: {
      inspect: async (endpoint) =>
        options.listenerIdentity?.(endpoint) ?? listeners.get(endpoint.origin) ?? null,
    },
    http: {
      request: async ({ origin, path }) => {
        requests.push(`${origin}${path}`);
        if (options.requestDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.requestDelayMs));
        }
        const isBackend = path.includes("well-known");
        return {
          status: isBackend ? (options.backendStatus ?? 200) : (options.webStatus ?? 200),
          url: options.responseUrl?.(origin, path) ?? `${origin}${path}`,
          ...(isBackend
            ? {
                json: {
                  environmentId: environmentIds.get(origin) ?? target.environmentIdentity,
                  label: "Validation",
                  platform: { os: "darwin", arch: "arm64" },
                  serverVersion: "0.0.23",
                  capabilities: {},
                  ...options.backendResponse?.(),
                },
              }
            : { text: options.webText?.() ?? html }),
        };
      },
    },
    adopter: {
      adopt: async () => {
        adoptCount += 1;
      },
    },
  };

  return {
    adapters,
    getState: (stateDirectory = target.stateDirectory) => states.get(stateDirectory),
    setState: (
      next: StoredValidationEnvironment | null,
      stateDirectory = target.stateDirectory,
    ) => {
      if (next === null) states.delete(stateDirectory);
      else states.set(stateDirectory, next);
    },
    processes,
    listeners,
    requests,
    diagnostics,
    setProcessIdentityOverride(
      override: (
        identity: ValidationEnvironmentProcessIdentity,
      ) => ValidationEnvironmentProcessIdentity | null,
    ) {
      processInspect = async (identity) => override(identity);
    },
    get launchCount() {
      return launchCount;
    },
    get maxActiveStarts() {
      return maxActiveStarts;
    },
    get adoptCount() {
      return adoptCount;
    },
    get terminateCount() {
      return terminateCount;
    },
  };
}

async function acquire(
  harness: ReturnType<typeof makeHarness>,
  requestedTarget = target,
): Promise<ValidationEnvironmentLease> {
  return createValidationEnvironmentManager(harness.adapters, {
    readinessTimeoutMs: 30,
    requestTimeoutMs: 20,
    pollIntervalMs: 1,
  }).acquire(requestedTarget);
}

describe("ValidationEnvironmentManager", () => {
  it("returns validated identity, actual ports, origins, process identities, and state", async () => {
    const harness = makeHarness();
    const lease = await acquire(harness);

    expect(lease.environmentIdentity).toBe(target.environmentIdentity);
    expect(lease.backendPort).toBe(4002);
    expect(lease.webPort).toBe(4003);
    expect(lease.backendOrigin).toBe("http://127.0.0.1:4002");
    expect(lease.webOrigin).toBe("http://127.0.0.1:4003");
    expect(lease.backend.process.startIdentity).toBe("start-1-backend");
    expect(lease.web.process.startIdentity).toBe("start-1-web");
    expect(lease.stateDirectory).toBe(target.stateDirectory);
    expect(harness.adoptCount).toBe(1);
  });

  it("requires an explicit absolute state directory", async () => {
    const harness = makeHarness();
    await expect(acquire(harness, { ...target, stateDirectory: "" })).rejects.toMatchObject({
      code: "state-directory-required",
    });
    await expect(
      acquire(harness, { ...target, stateDirectory: "relative-state" }),
    ).rejects.toMatchObject({ code: "state-directory-required" });
    expect(harness.launchCount).toBe(0);
  });

  it("reuses one exact target and launch configuration for concurrent callers", async () => {
    const harness = makeHarness({ startDelayMs: 5 });
    const manager = createValidationEnvironmentManager(harness.adapters, {
      readinessTimeoutMs: 30,
      requestTimeoutMs: 20,
      pollIntervalMs: 1,
    });
    const [first, second] = await Promise.all([
      manager.acquire(target),
      manager.acquire(structuredClone(target)),
    ]);

    expect(harness.launchCount).toBe(1);
    expect(first.ownershipIdentity).toBe(second.ownershipIdentity);
    await Promise.all([first.release(), second.release()]);
    await first.release();
    expect(harness.terminateCount).toBe(2);
  });

  it("reuses an exact persisted record only after revalidating its listeners and descriptor", async () => {
    const harness = makeHarness();
    const firstManager = createValidationEnvironmentManager(harness.adapters, {
      readinessTimeoutMs: 30,
      requestTimeoutMs: 20,
      pollIntervalMs: 1,
    });
    await firstManager.acquire(target);

    const secondManager = createValidationEnvironmentManager(harness.adapters, {
      readinessTimeoutMs: 30,
      requestTimeoutMs: 20,
      pollIntervalMs: 1,
    });
    const reused = await secondManager.acquire(target);

    expect(harness.launchCount).toBe(1);
    expect(reused.backend.process.pid).toBe(10_000);
    expect(harness.adoptCount).toBe(2);
  });

  it.each([
    ["workspaceRoot", { workspaceRoot: "/other-repo" }],
    ["worktreePath", { worktreePath: "/other-worktree" }],
    ["branch", { branch: "other-branch" }],
    ["revision", { revision: "revision-2" }],
    ["dirty fingerprint", { dirtyStateFingerprint: "dirty-2" }],
    ["environment identity", { environmentIdentity: "environment-2" }],
    ["state directory", { stateDirectory: "/tmp/t3-validation/other" }],
    ["launch config", { launchConfig: { ...target.launchConfig, args: ["dev", "--other"] } }],
  ])("starts a new isolated environment when %s differs", async (_name, change) => {
    const harness = makeHarness();
    const first = await acquire(harness);
    const second = await acquire(harness, { ...target, ...change });

    expect(harness.launchCount).toBe(2);
    expect(second.ownershipIdentity).not.toBe(first.ownershipIdentity);
  });

  it("terminates the exact persisted owner before replacing mismatched state", async () => {
    const harness = makeHarness();
    await acquire(harness);

    await acquire(harness, { ...target, revision: "revision-2" });

    expect(harness.launchCount).toBe(2);
    expect(harness.terminateCount).toBe(2);
  });

  it("terminates the stale persisted owner and launches fresh after failed revalidation", async () => {
    const harness = makeHarness();
    const first = await acquire(harness);
    const staleOwnership = first.ownershipIdentity;

    // Simulate backend death: the persisted processes and listeners vanish.
    harness.processes.clear();
    harness.listeners.clear();

    const second = await acquire(harness);

    expect(second.ownershipIdentity).not.toBe(staleOwnership);
    expect(harness.launchCount).toBe(2);
    expect(harness.getState()?.ownershipIdentity).toBe(second.ownershipIdentity);
    expect(second.backend.process.pid).not.toBe(first.backend.process.pid);
    await second.release();
  });

  it("does not relaunch over mismatched state when old ownership is ambiguous", async () => {
    const harness = makeHarness();
    await acquire(harness);
    harness.setProcessIdentityOverride((identity) => ({
      ...identity,
      startIdentity: "reused",
    }));

    await expect(acquire(harness, { ...target, revision: "revision-2" })).rejects.toMatchObject({
      code: "cleanup-ambiguous",
    });
    expect(harness.launchCount).toBe(1);
    expect(harness.terminateCount).toBe(0);
    expect(harness.diagnostics.length).toBeGreaterThan(0);
  });

  it("keeps backend and web readiness independent when backend is first", async () => {
    const harness = makeHarness({ requestDelayMs: 2 });
    const lease = await acquire(harness);
    expect(lease.backendPort).toBe(4002);
    expect(harness.requests.some((request) => request.endsWith("/"))).toBe(true);
    expect(harness.requests.some((request) => request.includes("well-known"))).toBe(true);
  });

  it("keeps backend and web readiness independent when web is first", async () => {
    const harness = makeHarness({
      backendResponse: () => ({ environmentId: target.environmentIdentity }),
    });
    const lease = await acquire(harness);
    expect(lease.webOrigin).toContain("4003");
  });

  it("returns a typed timeout when neither endpoint becomes ready", async () => {
    const harness = makeHarness({ backendStatus: 503, webStatus: 503 });
    await expect(acquire(harness)).rejects.toSatisfy((error) => {
      return errorCode(error) === "startup-timeout";
    });
  });

  it("returns a typed partial-startup outcome when only one endpoint is ready", async () => {
    const harness = makeHarness({ webStatus: 503 });
    await expect(acquire(harness)).rejects.toMatchObject({ code: "partial-startup" });
  });

  it("rejects an early process exit", async () => {
    const harness = makeHarness({ exitWebOnStart: true });
    await expect(acquire(harness)).rejects.toMatchObject({ code: "early-exit" });
  });

  it("rejects descriptor identity mismatch", async () => {
    const harness = makeHarness({
      backendResponse: () => ({ environmentId: "wrong-environment" }),
    });
    await expect(acquire(harness)).rejects.toMatchObject({ code: "descriptor-mismatch" });
  });

  it("rejects non-T3 HTML", async () => {
    const harness = makeHarness({
      webText: () =>
        "<!doctype html><html><head><title>Other app</title></head><body></body></html>",
    });
    await expect(acquire(harness)).rejects.toMatchObject({ code: "non-t3-html" });
  });

  it("rejects a readiness response from the wrong origin", async () => {
    const harness = makeHarness({
      responseUrl: (origin, path) => `${origin.replace("4002", "4999")}${path}`,
    });
    await expect(acquire(harness)).rejects.toMatchObject({ code: "wrong-origin" });
  });

  it("rejects listener replacement instead of admitting the impostor", async () => {
    const harness = makeHarness({
      listenerIdentity: (endpoint) => ({
        pid: endpoint.process.pid + 1,
        startIdentity: "replacement",
        ownershipIdentity: endpoint.process.ownershipIdentity,
      }),
    });
    await expect(acquire(harness)).rejects.toMatchObject({ code: "impostor-listener" });
  });

  it("rejects PID reuse and never terminates the replacement process", async () => {
    const harness = makeHarness({
      processIdentity: (identity) => ({
        ...identity,
        startIdentity: "replacement-start",
      }),
    });
    await expect(acquire(harness)).rejects.toMatchObject({ code: "pid-reuse" });
    expect(harness.terminateCount).toBe(0);
  });

  it("rejects ambiguous ownership and never terminates an ambiguous process", async () => {
    const harness = makeHarness({
      processIdentity: (identity) => ({
        ...identity,
        ownershipIdentity: "other-owner",
      }),
    });
    await expect(acquire(harness)).rejects.toMatchObject({ code: "ambiguous-ownership" });
    expect(harness.terminateCount).toBe(0);
  });

  it("starts unrelated targets concurrently", async () => {
    const harness = makeHarness({ startDelayMs: 5 });
    await Promise.all([
      acquire(harness, target),
      acquire(harness, {
        ...target,
        stateDirectory: "/tmp/t3-validation/environment-2",
        environmentIdentity: "environment-2",
      }),
    ]);
    expect(harness.launchCount).toBe(2);
    expect(harness.maxActiveStarts).toBe(2);
  });

  it("releases idempotently and only terminates processes with matching ownership", async () => {
    const harness = makeHarness();
    const lease = await acquire(harness);
    await lease.release();
    await lease.release();
    expect(harness.terminateCount).toBe(2);

    const second = await acquire(harness);
    harness.setProcessIdentityOverride((identity) => ({
      ...identity,
      startIdentity: "reused",
    }));
    await expect(second.release()).rejects.toMatchObject({ code: "cleanup-ambiguous" });
    expect(harness.terminateCount).toBe(2);
    expect(harness.diagnostics.length).toBeGreaterThan(0);
  });
});
