import { DateTime, Effect } from "effect";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  EnvironmentId,
  ThreadId,
  type BrowserValidationScenario,
  type ExecutionEnvironmentDescriptor,
  type PreviewAutomationPreflightResult,
  type PreviewAutomationSnapshot,
  type ValidationTarget,
} from "@t3tools/contracts";

import type { BootstrapCredentialService } from "../auth/Services/BootstrapCredentialService.ts";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { executeBrowserValidation, evaluateAssertion } from "./BrowserValidationExecutor.ts";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const png = PNG.sync.write(new PNG({ width: 2, height: 1 }));

const environment: ExecutionEnvironmentDescriptor = {
  environmentId,
  label: "Test environment",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "test",
  capabilities: { repositoryIdentity: true },
};

const target: ValidationTarget = {
  workspaceRoot: "/workspace",
  worktreePath: null,
  branch: "feature",
  revision: "revision-1",
  dirtyStateFingerprint: "dirty-1",
  environmentIdentity: environmentId,
};

const scenario: BrowserValidationScenario = {
  id: "authenticated-flow",
  label: "Authenticated flow",
  target: {
    kind: "environment-port",
    port: 5173,
    protocol: "http",
    path: "/app",
  },
  authentication: {
    origin: "http://localhost:5173",
    pathPrefix: "/app",
    requiredText: "Signed in",
  },
  actions: [{ id: "continue", operation: "press", input: { key: "Enter" } }],
  assertions: [
    { id: "signed-in", kind: "visible-text", expected: "Complete" },
    { id: "not-loading", kind: "not-loading" },
  ],
  media: [{ kind: "screenshot", required: true }],
};

const snapshot = (url = "http://localhost:5173/app"): PreviewAutomationSnapshot => ({
  tabId: "tab-1" as never,
  url,
  title: "Application",
  loading: false,
  visibleText: "Signed in Complete",
  interactiveElements: [],
  accessibilityTree: null,
  consoleEntries: [
    { level: "info", text: "ready", timestamp: "now" },
    { level: "error", text: "Bearer secret", timestamp: "now" },
  ],
  networkEntries: [
    {
      url: "http://localhost:5173/api/data?credential=secret",
      method: "GET",
      status: 200,
      failed: false,
      timestamp: "now",
    },
  ],
  actionTimeline: [],
  screenshot: {
    mimeType: "image/png",
    data: png.toString("base64"),
    width: 2,
    height: 1,
  },
});

const preflight = (
  overrides: {
    readonly browser?: Partial<PreviewAutomationPreflightResult["browser"]>;
    readonly mcp?: Partial<PreviewAutomationPreflightResult["mcp"]>;
    readonly target?: Partial<PreviewAutomationPreflightResult["target"]>;
    readonly recovery?: Partial<PreviewAutomationPreflightResult["recovery"]>;
  } = {},
) => {
  const base: PreviewAutomationPreflightResult = {
    browser: {
      supported: true,
      available: true,
      visible: false,
      tabAttached: true,
      tabId: "tab-1",
    },
    mcp: { credential: "valid" },
    target: {
      requested: true,
      reachability: "reachable",
      app: "expected-t3-app",
      origin: "http://localhost:5173",
      environmentId,
      status: 200,
    },
    recovery: { kind: "pair-after-preflight", message: "Pair after preflight." },
  };
  return {
    ...base,
    browser: { ...base.browser, ...overrides.browser },
    mcp: { ...base.mcp, ...overrides.mcp },
    target: { ...base.target, ...overrides.target },
    recovery: { ...base.recovery, ...overrides.recovery },
  };
};

const dependencies = (input: {
  readonly preflights: ReadonlyArray<PreviewAutomationPreflightResult>;
  readonly pairing?: PreviewAutomationSnapshot;
  readonly final?: PreviewAutomationSnapshot;
  readonly failOperation?: string;
  readonly failureMessage?: string;
  readonly revokeFails?: boolean;
  readonly invoke?: (request: {
    readonly operation: string;
    readonly input: unknown;
    readonly tabId?: unknown;
  }) => Effect.Effect<unknown, unknown>;
}) => {
  const calls: Array<{ operation: string; input: unknown; tabId?: unknown }> = [];
  let preflightIndex = 0;
  let issueCount = 0;
  let revokeCount = 0;
  const dependenciesValue = input;
  const invoke =
    input.invoke ??
    (({
      operation,
      input: requestInput,
      tabId,
    }: {
      operation: string;
      input: unknown;
      tabId?: unknown;
    }) => {
      calls.push({ operation, input: requestInput, ...(tabId === undefined ? {} : { tabId }) });
      if (operation === input.failOperation) {
        return Effect.fail(new Error(input.failureMessage ?? "operation failed"));
      }
      if (operation === "preflight") {
        return Effect.succeed(
          dependenciesValue.preflights[
            Math.min(preflightIndex++, dependenciesValue.preflights.length - 1)
          ],
        );
      }
      if (operation === "openAndSnapshot") {
        return Effect.succeed(dependenciesValue.pairing ?? snapshot());
      }
      if (operation === "snapshot") {
        return Effect.succeed(dependenciesValue.final ?? snapshot());
      }
      if (operation === "recordingStart") {
        return Effect.succeed({ tabId: "tab-1", recording: true, startedAt: "now" });
      }
      if (operation === "recordingStop") {
        return Effect.succeed({
          id: "recording-1",
          tabId: "tab-1",
          path: "/tmp/recording.webm",
          mimeType: "video/webm",
        });
      }
      return Effect.succeed(null);
    });
  const broker = { invoke };
  const credentials = {
    issueOneTimeToken: () => {
      issueCount += 1;
      return Effect.succeed({
        id: "credential-id",
        credential: "secret-token",
        scopes: [],
        expiresAt: DateTime.nowUnsafe(),
      });
    },
    revoke: () => {
      revokeCount += 1;
      if (input.revokeFails) {
        return Effect.fail(new Error("credential revoke failed"));
      }
      return Effect.succeed(true);
    },
  };
  return {
    broker: broker as unknown as PreviewAutomationBroker["Service"],
    credentials: credentials as unknown as BootstrapCredentialService["Service"],
    calls,
    get issueCount() {
      return issueCount;
    },
    get revokeCount() {
      return revokeCount;
    },
  };
};

const input = (overrides: Partial<BrowserValidationScenario> = {}) => ({
  runId: "run-1",
  gateId: "browser-validation",
  executorId: "executor-1",
  target,
  environment,
  scenario: { ...scenario, ...overrides },
  threadId,
});

describe("browser validation executor", () => {
  it("blocks environment mismatch before preflight and never issues a token", async () => {
    const deps = dependencies({ preflights: [preflight()] });
    const result = await Effect.runPromise(
      executeBrowserValidation(deps, {
        ...input(),
        target: { ...target, environmentIdentity: EnvironmentId.make("other") },
      }),
    );
    expect(result.outcome).toBe("blocked");
    expect(deps.issueCount).toBe(0);
    expect(deps.calls).toHaveLength(0);
  });

  it.each<[string, Parameters<typeof preflight>[0]]>([
    ["unsupported browser", { browser: { ...preflight().browser, supported: false } }],
    ["unavailable target", { target: { ...preflight().target, reachability: "unreachable" } }],
    [
      "invalid MCP credential",
      {
        mcp: { credential: "invalid" } as unknown as PreviewAutomationPreflightResult["mcp"],
      },
    ],
  ])("blocks %s without issuing a token", async (_label, overrides) => {
    const deps = dependencies({ preflights: [preflight(overrides)] });
    const result = await Effect.runPromise(executeBrowserValidation(deps, input()));
    expect(result.outcome).toBe("blocked");
    expect(deps.issueCount).toBe(0);
  });

  it("reports an unrequested preflight target actionably", async () => {
    const deps = dependencies({
      preflights: [preflight({ target: { ...preflight().target, requested: false } })],
    });
    const result = await Effect.runPromise(executeBrowserValidation(deps, input()));
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostics[0]?.message).toContain("did not request");
    expect(deps.issueCount).toBe(0);
  });

  it("reports a preflight environment mismatch actionably", async () => {
    const deps = dependencies({
      preflights: [
        preflight({
          target: { ...preflight().target, environmentId: EnvironmentId.make("other") },
        }),
      ],
    });
    const result = await Effect.runPromise(executeBrowserValidation(deps, input()));
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostics[0]?.message).toContain("different environment");
    expect(deps.issueCount).toBe(0);
  });

  it("retries preflight with an open browser when the first tab id is missing", async () => {
    const deps = dependencies({
      preflights: [
        preflight({
          browser: { ...preflight().browser, tabId: null },
          recovery: { kind: "none", message: "No tab yet." },
        }),
        preflight(),
      ],
    });
    const result = await Effect.runPromise(executeBrowserValidation(deps, input()));
    expect(result.outcome).toBe("passed");
    expect(deps.calls.map((call) => call.operation)).toEqual([
      "preflight",
      "preflight",
      "openAndSnapshot",
      "press",
      "snapshot",
    ]);
  });

  it("rejects authentication on a path that only shares a prefix", async () => {
    const deps = dependencies({ preflights: [preflight()] });
    const result = await Effect.runPromise(
      executeBrowserValidation(
        deps,
        input({
          authentication: { ...scenario.authentication, pathPrefix: "/app" },
        }),
      ),
    );
    // Default pairing snapshot serves /app, which satisfies the prefix.
    expect(result.outcome).toBe("passed");

    const wrongPage = dependencies({
      preflights: [preflight()],
      pairing: snapshot("http://localhost:5173/application"),
    });
    const rejected = await Effect.runPromise(
      executeBrowserValidation(
        wrongPage,
        input({
          authentication: { ...scenario.authentication, pathPrefix: "/app" },
        }),
      ),
    );
    expect(rejected.outcome).toBe("failed");
    expect(wrongPage.calls.map((call) => call.operation)).toEqual(["preflight", "openAndSnapshot"]);
  });

  it("fails url-origin assertions when either origin is unparseable", () => {
    const assertion = { id: "origin", kind: "url-origin" as const, expected: "http://a.example/" };
    expect(evaluateAssertion(snapshot("http://a.example/page"), assertion).passed).toBe(true);
    expect(evaluateAssertion(snapshot("http://b.example/page"), assertion).passed).toBe(false);
    expect(evaluateAssertion(snapshot("not a url"), assertion).passed).toBe(false);
    expect(
      evaluateAssertion(snapshot("http://a.example/page"), {
        ...assertion,
        expected: "not a url",
      }).passed,
    ).toBe(false);
    expect(
      evaluateAssertion(snapshot("not a url"), { ...assertion, expected: "also bad" }).passed,
    ).toBe(false);
  });

  it("blocks when browser recovery still has no attached tab", async () => {
    const noTab = preflight({
      browser: { ...preflight().browser, tabAttached: false, tabId: null },
      recovery: { kind: "none", message: "No tab attached." },
    });
    const deps = dependencies({ preflights: [noTab, noTab] });
    const result = await Effect.runPromise(executeBrowserValidation(deps, input()));
    expect(result.outcome).toBe("blocked");
    expect(deps.issueCount).toBe(0);
    expect(deps.calls.map((call) => call.operation)).toEqual(["preflight", "preflight"]);
  });

  it("blocks assertions that omit an expected value before pairing", async () => {
    const deps = dependencies({ preflights: [preflight()] });
    const result = await Effect.runPromise(
      executeBrowserValidation(
        deps,
        input({
          assertions: [{ id: "missing", kind: "visible-text" }],
        }),
      ),
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostics[0]?.message).toContain("requires an expected value");
    expect(deps.issueCount).toBe(0);
    expect(deps.calls).toHaveLength(0);
  });

  it("recovers the browser, pairs once after preflight, asserts auth, and returns sanitized evidence", async () => {
    const deps = dependencies({
      preflights: [
        preflight({
          browser: { ...preflight().browser, tabAttached: false, tabId: null },
          recovery: { kind: "open-browser", message: "Open the browser." },
        }),
        preflight(),
      ],
    });
    const result = await Effect.runPromise(executeBrowserValidation(deps, input()));
    expect(result.outcome).toBe("passed");
    expect(deps.issueCount).toBe(1);
    expect(deps.revokeCount).toBe(1);
    expect(deps.calls.map((call) => call.operation)).toEqual([
      "preflight",
      "preflight",
      "openAndSnapshot",
      "press",
      "snapshot",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(result.evidence.verification).toBe("verified");
    expect(result.evidence.media[0]).toMatchObject({
      kind: "screenshot",
      runId: "run-1",
      gateId: "browser-validation",
      executorId: "executor-1",
    });
  });

  it("fails authentication before scenario actions", async () => {
    const deps = dependencies({
      preflights: [preflight()],
      pairing: snapshot("http://localhost:5173/login"),
    });
    const result = await Effect.runPromise(executeBrowserValidation(deps, input()));
    expect(result.outcome).toBe("failed");
    expect(deps.calls.map((call) => call.operation)).toEqual(["preflight", "openAndSnapshot"]);
  });

  it("stops required recording after an action fails on the validation tab", async () => {
    const deps = dependencies({
      preflights: [preflight()],
      failOperation: "press",
      failureMessage: "action failed",
    });
    const result = await Effect.runPromise(
      executeBrowserValidation(deps, input({ media: [{ kind: "recording", required: true }] })),
    );
    expect(result.outcome).toBe("failed");
    expect(deps.calls.map((call) => call.operation)).toEqual([
      "preflight",
      "openAndSnapshot",
      "recordingStart",
      "press",
      "recordingStop",
    ]);
    expect(deps.calls.at(-1)?.tabId).toBe("tab-1");
  });

  it("rejects a cross-origin redirect after actions", async () => {
    const deps = dependencies({
      preflights: [preflight()],
      final: snapshot("https://other.example/app"),
    });
    const result = await Effect.runPromise(executeBrowserValidation(deps, input()));
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics[0]?.message).toContain("another origin");
  });

  it("redacts the pairing token from post-pair broker errors", async () => {
    const deps = dependencies({
      preflights: [preflight()],
      failOperation: "snapshot",
      failureMessage: "broker echoed secret-token",
    });
    const result = await Effect.runPromise(executeBrowserValidation(deps, input()));
    expect(result.outcome).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it.each<[string, Array<{ kind: "recording"; required: boolean }> | undefined]>([
    ["openAndSnapshot", undefined],
    ["press", undefined],
    ["recordingStart", [{ kind: "recording", required: true }]],
    ["recordingStop", [{ kind: "recording", required: true }]],
  ])("redacts the pairing token from %s broker errors", async (operation, media) => {
    const deps = dependencies({
      preflights: [preflight()],
      failOperation: operation,
      failureMessage: "broker echoed secret-token",
    });
    const result = await Effect.runPromise(
      executeBrowserValidation(deps, input(media === undefined ? {} : { media })),
    );
    expect(["failed", "blocked"]).toContain(result.outcome);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("retains a sanitized diagnostic when credential revocation fails", async () => {
    const deps = dependencies({
      preflights: [preflight()],
      failOperation: "openAndSnapshot",
      failureMessage: "pairing failed",
      revokeFails: true,
    });
    const result = await Effect.runPromise(executeBrowserValidation(deps, input()));
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostics).toContainEqual({
      kind: "persistence",
      message: "credential revoke failed",
    });
  });

  it("retains sanitized diagnostics for an interrupted browser operation", async () => {
    const interrupted = dependencies({
      preflights: [preflight()],
      invoke: () =>
        Effect.fail({
          _tag: "PreviewAutomationControlInterruptedError",
          message: "interrupted Bearer secret-token",
        }),
    });
    const result = await Effect.runPromise(executeBrowserValidation(interrupted, input()));
    expect(result.outcome).toBe("interrupted");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});
