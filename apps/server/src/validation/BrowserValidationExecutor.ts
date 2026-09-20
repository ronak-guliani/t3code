import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BrowserValidationAppState,
  BrowserValidationAssertionResult,
  BrowserValidationDiagnostics,
  BrowserValidationEvidence,
  BrowserValidationExecutionInput,
  BrowserValidationIdentity,
  BrowserValidationMediaEvidence,
  BrowserValidationOutcome,
  BrowserValidationResult,
  BrowserValidationScenario,
  ExecutionEnvironmentDescriptor,
  PreviewAutomationOpenAndSnapshotResult,
  PreviewAutomationPreflightResult,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { Effect, Context, Layer } from "effect";

import * as BootstrapCredentialService from "../auth/Services/BootstrapCredentialService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import {
  browserValidationAppState,
  browserValidationFinalSnapshot,
  diagnosticFromError,
  diagnosticsFromSnapshot,
  redactBrowserValidationText,
  sanitizeBrowserValidationUrl,
  validateBrowserValidationMedia,
  type BrowserValidationMediaPersistence,
  type BrowserValidationRecordingDecoder,
} from "./BrowserValidationEvidence.ts";

type PreviewBroker = PreviewAutomationBroker.PreviewAutomationBroker["Service"];
type CredentialService = BootstrapCredentialService.BootstrapCredentialService["Service"];

export interface BrowserValidationExecutorDependencies {
  readonly broker: PreviewBroker;
  readonly credentials: CredentialService;
  readonly readRecording?: (artifact: PreviewAutomationRecordingArtifact) => Promise<Uint8Array>;
  readonly recordingDecoder?: BrowserValidationRecordingDecoder;
  readonly mediaPersistence?: BrowserValidationMediaPersistence;
}

export interface BrowserValidationExecutorShape {
  readonly execute: (
    input: BrowserValidationExecutionInput,
  ) => Effect.Effect<BrowserValidationResult>;
}

const execFileAsync = promisify(execFile);

export class BrowserValidationExecutor extends Context.Service<
  BrowserValidationExecutor,
  BrowserValidationExecutorShape
>()("t3/validation/BrowserValidationExecutor") {}

class BrowserValidationAbort extends Error {
  readonly _tag = "BrowserValidationAbort";
  readonly outcome: Exclude<BrowserValidationOutcome, "passed">;
  readonly kind: "browser" | "media" | "persistence";

  constructor(
    outcome: Exclude<BrowserValidationOutcome, "passed">,
    kind: "browser" | "media" | "persistence",
    message: string,
  ) {
    super(message);
    this.outcome = outcome;
    this.kind = kind;
  }
}

interface ExecutionState {
  identity: BrowserValidationIdentity;
  scenario: BrowserValidationScenario;
  diagnostics: BrowserValidationDiagnostics;
  extraDiagnostics: ReturnType<typeof diagnosticFromError>[];
  assertionResults: BrowserValidationAssertionResult[];
  media: BrowserValidationMediaEvidence[];
  authenticated: boolean;
  finalSnapshot: PreviewAutomationSnapshot | null;
  appState: BrowserValidationAppState | null;
  tabId: string | undefined;
}

const identityOf = (input: BrowserValidationExecutionInput): BrowserValidationIdentity => ({
  runId: input.runId,
  gateId: input.gateId,
  executorId: input.executorId,
  threadId: input.threadId,
  revision: input.target.revision,
  environmentId: input.environment.environmentId,
});

const emptyDiagnostics = (): BrowserValidationDiagnostics => ({ console: [], network: [] });

const originOf = (value: string): string | null => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const pathOf = (value: string): string | null => {
  try {
    return new URL(value).pathname;
  } catch {
    return null;
  }
};

const expectedOriginOfTarget = (scenario: BrowserValidationScenario): string | null =>
  scenario.target.kind === "url" ? originOf(scenario.target.url) : null;

const strictBase64 = (value: string): Uint8Array => {
  const normalized = value.replace(/\s+/g, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) ||
    Buffer.from(normalized, "base64").toString("base64") !== normalized
  ) {
    throw new BrowserValidationAbort("failed", "media", "Screenshot data was not valid base64.");
  }
  return Uint8Array.from(Buffer.from(normalized, "base64"));
};

const safeErrorMessage = (error: unknown, secret?: string): string => {
  const message = error instanceof Error ? error.message : "Browser validation operation failed.";
  return redactBrowserValidationText(
    secret === undefined || secret.length === 0
      ? message
      : message.replaceAll(secret, "[redacted]"),
  );
};

const errorOutcome = (error: unknown): Exclude<BrowserValidationOutcome, "passed"> =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof error._tag === "string" &&
  error._tag.toLowerCase().includes("interrupt")
    ? "interrupted"
    : "failed";

const hasAttachedTab = (result: PreviewAutomationPreflightResult): boolean => {
  const tabId = result.tabId ?? result.browser.tabId;
  return result.browser.tabAttached && tabId !== null && tabId !== undefined;
};

const preflightIsUsable = (
  result: PreviewAutomationPreflightResult,
  environment: ExecutionEnvironmentDescriptor,
): boolean =>
  result.browser.supported &&
  result.browser.available &&
  result.mcp.credential === "valid" &&
  hasAttachedTab(result) &&
  result.target.requested &&
  result.target.reachability === "reachable" &&
  result.target.app === "expected-t3-app" &&
  result.target.environmentId === environment.environmentId &&
  (result.recovery.kind === "none" || result.recovery.kind === "pair-after-preflight");

const preflightFailureMessage = (
  result: PreviewAutomationPreflightResult,
  environment: ExecutionEnvironmentDescriptor,
): string => {
  if (!result.browser.supported) return "The connected browser does not support automation.";
  if (!result.browser.available) return "No automation-capable browser host is available.";
  if (result.mcp.credential !== "valid") return "The preview automation credential is invalid.";
  if (!hasAttachedTab(result)) {
    return "Browser preflight did not attach a controllable tab.";
  }
  if (!result.target.requested) {
    return "Browser preflight did not request the expected validation target.";
  }
  if (result.target.reachability !== "reachable") return "The validation target is unavailable.";
  if (result.target.app !== "expected-t3-app")
    return "The target is not the expected T3 application.";
  if (result.target.environmentId !== environment.environmentId) {
    return "The connected browser is attached to a different environment.";
  }
  if (result.recovery.kind !== "none" && result.recovery.kind !== "pair-after-preflight") {
    return result.recovery.message;
  }
  return "Browser preflight did not establish a usable target.";
};

const matchesAuthentication = (
  snapshot: PreviewAutomationSnapshot,
  scenario: BrowserValidationScenario,
  expectedOrigin: string,
): boolean =>
  originOf(snapshot.url) === expectedOrigin &&
  originOf(scenario.authentication.origin) === expectedOrigin &&
  (scenario.authentication.pathPrefix === undefined ||
    pathOf(snapshot.url)?.startsWith(scenario.authentication.pathPrefix) === true) &&
  snapshot.visibleText.includes(scenario.authentication.requiredText);

const evaluateAssertion = (
  snapshot: PreviewAutomationSnapshot,
  assertion: BrowserValidationScenario["assertions"][number],
): BrowserValidationAssertionResult => {
  const expected = assertion.expected;
  if (assertion.kind !== "not-loading" && (expected === undefined || expected.trim() === "")) {
    return {
      id: assertion.id,
      passed: false,
      observed: "missing expected value",
    };
  }
  const expectedText = expected ?? "";
  const passed = (() => {
    switch (assertion.kind) {
      case "visible-text":
        return snapshot.visibleText.includes(expectedText);
      case "url-origin":
        return originOf(snapshot.url) === originOf(expectedText);
      case "url-path":
        return pathOf(snapshot.url) === expectedText;
      case "title":
        return snapshot.title.includes(expectedText);
      case "not-loading":
        return !snapshot.loading;
    }
  })();
  const observed =
    assertion.kind === "visible-text"
      ? snapshot.visibleText
      : assertion.kind === "title"
        ? snapshot.title
        : assertion.kind === "not-loading"
          ? String(!snapshot.loading)
          : sanitizeBrowserValidationUrl(snapshot.url);
  return {
    id: assertion.id,
    passed,
    observed: redactBrowserValidationText(observed).slice(0, 1_000),
  };
};

const requiredMedia = (scenario: BrowserValidationScenario, kind: "screenshot" | "recording") =>
  scenario.media.some((requirement) => requirement.kind === kind && requirement.required);

const makeEvidence = (
  state: ExecutionState,
  verification: "verified" | "diagnostic-only",
): BrowserValidationEvidence => ({
  verification,
  identity: state.identity,
  scenarioId: state.scenario.id,
  authentication: {
    id: "authenticated-application",
    passed: state.authenticated,
    observed: state.appState?.path ?? "not-observed",
  },
  assertions: [...state.assertionResults],
  finalSnapshot:
    state.finalSnapshot === null ? null : browserValidationFinalSnapshot(state.finalSnapshot),
  appState: state.appState,
  diagnostics: {
    console: [...state.diagnostics.console],
    network: [...state.diagnostics.network],
  },
  media: [...state.media],
});

const makeResult = (
  state: ExecutionState,
  outcome: BrowserValidationOutcome,
): BrowserValidationResult => ({
  outcome,
  identity: state.identity,
  evidence: makeEvidence(state, outcome === "passed" ? "verified" : "diagnostic-only"),
  diagnostics: [...state.extraDiagnostics],
});

const scopeOf = (input: BrowserValidationExecutionInput): McpInvocationScope => ({
  environmentId: input.environment.environmentId,
  threadId: input.threadId,
  providerSessionId: `validation:${input.runId}`,
  providerInstanceId: ProviderInstanceId.make("validation"),
  capabilities: new Set(["preview"]),
  issuedAt: Date.now(),
});

const readRecording = (
  dependencies: BrowserValidationExecutorDependencies,
  artifact: PreviewAutomationRecordingArtifact,
): Promise<Uint8Array> =>
  dependencies.readRecording
    ? dependencies.readRecording(artifact)
    : readFile(artifact.path).then((bytes) => Uint8Array.from(bytes));

const defaultSmallRecordingDecoder = (
  broker: PreviewBroker,
  scope: McpInvocationScope,
  tabId: string,
): BrowserValidationRecordingDecoder => ({
  decode: async ({ bytes, mimeType }) => {
    const encoded = Buffer.from(bytes).toString("base64");
    if (encoded.length > 40_000) {
      throw new Error("Recording requires an injected decoder for payloads above 40 KB.");
    }
    const expression = `(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(encoded)}), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: ${JSON.stringify(mimeType)} }));
      const video = document.createElement("video");
      const ready = new Promise((resolve, reject) => {
        video.addEventListener("loadedmetadata", resolve, { once: true });
        video.addEventListener("error", () => reject(new Error("Recording could not be decoded")), { once: true });
      });
      video.src = url;
      try {
        await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("Recording decode timed out")), 10000))]);
        return { width: video.videoWidth, height: video.videoHeight, durationSeconds: video.duration };
      } finally {
        video.removeAttribute("src");
        URL.revokeObjectURL(url);
      }
    })()`;
    const result = await Effect.runPromise(
      broker.invoke<unknown>({
        scope,
        operation: "evaluate",
        input: { expression, awaitPromise: true, returnByValue: true },
        tabId,
      }),
    );
    if (typeof result !== "object" || result === null) {
      throw new Error("Recording decoder returned no metadata.");
    }
    const metadata = result as Record<string, unknown>;
    return {
      width: Number(metadata.width),
      height: Number(metadata.height),
      durationSeconds: Number(metadata.durationSeconds),
    };
  },
});

export const ffprobeBrowserValidationRecordingDecoder = (
  executable = process.env.T3CODE_FFPROBE_PATH ?? "ffprobe",
): BrowserValidationRecordingDecoder => ({
  decode: async ({ bytes, mimeType }) => {
    const directory = await mkdtemp(join(tmpdir(), "t3-browser-recording-"));
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    const path = join(directory, `recording.${extension}`);
    try {
      await writeFile(path, bytes, { mode: 0o600 });
      const { stdout } = await execFileAsync(
        executable,
        [
          "-v",
          "error",
          "-show_entries",
          "stream=width,height,duration:format=duration",
          "-of",
          "json",
          path,
        ],
        { timeout: 15_000, maxBuffer: 64 * 1024 },
      );
      const parsed = JSON.parse(stdout) as {
        readonly streams?: ReadonlyArray<{
          readonly width?: number;
          readonly height?: number;
          readonly duration?: string;
        }>;
        readonly format?: { readonly duration?: string };
      };
      const stream = parsed.streams?.find(
        (candidate) =>
          Number.isFinite(candidate.width) &&
          Number.isFinite(candidate.height) &&
          candidate.width !== undefined &&
          candidate.height !== undefined,
      );
      const durationSeconds = Number(stream?.duration ?? parsed.format?.duration);
      if (
        stream?.width === undefined ||
        stream.height === undefined ||
        !Number.isFinite(durationSeconds)
      ) {
        throw new Error("ffprobe returned incomplete recording metadata.");
      }
      return {
        width: stream.width,
        height: stream.height,
        durationSeconds,
      };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  },
});

const executePromise = async (
  dependencies: BrowserValidationExecutorDependencies,
  input: BrowserValidationExecutionInput,
): Promise<BrowserValidationResult> => {
  const state: ExecutionState = {
    identity: identityOf(input),
    scenario: input.scenario,
    diagnostics: emptyDiagnostics(),
    extraDiagnostics: [],
    assertionResults: [],
    media: [],
    authenticated: false,
    finalSnapshot: null,
    appState: null,
    tabId: undefined,
  };
  const scope = scopeOf(input);
  let pairingToken = "";
  let issuedCredentialId: string | undefined;
  let recordingStarted = false;
  let recordingStopped = false;
  let outcome: BrowserValidationOutcome = "failed";

  const fail = (
    outcome: Exclude<BrowserValidationOutcome, "passed">,
    kind: BrowserValidationAbort["kind"],
    message: string,
  ): never => {
    throw new BrowserValidationAbort(outcome, kind, message);
  };

  // Reads the live pairing token: empty before issuance and after revocation,
  // so every broker failure message is scrubbed of the one-time credential.
  const safeMessage = (error: unknown): string => safeErrorMessage(error, pairingToken);

  try {
    const invalidAssertion = input.scenario.assertions.find(
      (assertion) =>
        assertion.kind !== "not-loading" &&
        (assertion.expected === undefined || assertion.expected.trim() === ""),
    );
    if (invalidAssertion !== undefined) {
      fail("blocked", "browser", `Assertion ${invalidAssertion.id} requires an expected value.`);
    }
    if (
      input.target.environmentIdentity !== input.environment.environmentId ||
      scope.environmentId !== input.environment.environmentId
    ) {
      fail("blocked", "browser", "The captured validation target does not match the environment.");
    }

    let preflight = await Effect.runPromise(
      dependencies.broker.invoke<PreviewAutomationPreflightResult>({
        scope,
        operation: "preflight",
        input: {
          target: input.scenario.target,
          expectedEnvironmentId: input.environment.environmentId,
          open: false,
        },
      }),
    ).catch((error: unknown) =>
      fail(
        errorOutcome(error) === "interrupted" ? "interrupted" : "blocked",
        "browser",
        safeMessage(error),
      ),
    );

    if (preflight.recovery.kind === "open-browser" || !preflight.browser.tabAttached) {
      preflight = await Effect.runPromise(
        dependencies.broker.invoke<PreviewAutomationPreflightResult>({
          scope,
          operation: "preflight",
          input: {
            target: input.scenario.target,
            expectedEnvironmentId: input.environment.environmentId,
            open: true,
          },
        }),
      ).catch((error: unknown) =>
        fail(
          errorOutcome(error) === "interrupted" ? "interrupted" : "blocked",
          "browser",
          safeMessage(error),
        ),
      );
    }
    if (!preflightIsUsable(preflight, input.environment)) {
      fail("blocked", "browser", preflightFailureMessage(preflight, input.environment));
    }

    const targetOrigin = preflight.target.origin;
    const validatedOrigin =
      targetOrigin ??
      fail("blocked", "browser", "The validated environment did not provide an origin.");
    const scenarioOrigin = expectedOriginOfTarget(input.scenario);
    if (
      (scenarioOrigin !== null && scenarioOrigin !== targetOrigin) ||
      originOf(input.scenario.authentication.origin) !== targetOrigin
    ) {
      fail("blocked", "browser", "The target and validated environment origin do not match.");
    }
    state.tabId = preflight.tabId ?? preflight.browser.tabId ?? undefined;

    const issued = await Effect.runPromise(
      dependencies.credentials.issueOneTimeToken({
        role: "client",
        subject: `browser-validation:${input.runId}`,
        label: "browser-validation",
      }),
    ).catch((error: unknown) =>
      fail(
        errorOutcome(error) === "interrupted" ? "interrupted" : "blocked",
        "browser",
        safeMessage(error),
      ),
    );
    issuedCredentialId = issued.id;
    pairingToken = issued.credential;

    const pairing = await Effect.runPromise(
      dependencies.broker.invoke<PreviewAutomationOpenAndSnapshotResult>({
        scope,
        operation: "openAndSnapshot",
        input: {
          url: `${validatedOrigin}/pair#token=${encodeURIComponent(pairingToken)}`,
          open: false,
          readiness: "load",
          includeConsole: true,
          includeNetwork: true,
          consoleMode: "important",
          networkMode: "failed",
        },
      }),
    ).catch((error: unknown) =>
      fail(
        errorOutcome(error) === "interrupted" ? "interrupted" : "blocked",
        "browser",
        safeMessage(error),
      ),
    );
    state.tabId = pairing.tabId;
    state.diagnostics = diagnosticsFromSnapshot(pairing);
    state.authenticated = matchesAuthentication(pairing, input.scenario, validatedOrigin);
    state.appState = browserValidationAppState(pairing, state.authenticated);
    if (!state.authenticated) {
      fail("failed", "browser", "The paired tab did not show authenticated application state.");
    }

    if (requiredMedia(input.scenario, "recording")) {
      const recordingStatus = await Effect.runPromise(
        dependencies.broker.invoke<PreviewAutomationRecordingStatus>({
          scope,
          operation: "recordingStart",
          input: {},
          tabId: state.tabId,
        }),
      ).catch((error: unknown) => fail(errorOutcome(error), "media", safeMessage(error)));
      if (!recordingStatus.recording) {
        fail("failed", "media", "Required browser recording did not start.");
      }
      recordingStarted = true;
    }

    for (const action of input.scenario.actions) {
      await Effect.runPromise(
        dependencies.broker.invoke({
          scope,
          operation: action.operation,
          input: action.input,
          ...(state.tabId === undefined ? {} : { tabId: state.tabId }),
        }),
      ).catch((error: unknown) =>
        fail(
          errorOutcome(error),
          "browser",
          `Scenario action ${action.id} failed: ${safeMessage(error)}`,
        ),
      );
    }

    const finalSnapshot = await Effect.runPromise(
      dependencies.broker.invoke<PreviewAutomationSnapshot>({
        scope,
        operation: "snapshot",
        input: {
          includeConsole: true,
          includeNetwork: true,
          consoleMode: "all",
          networkMode: "all",
        },
        ...(state.tabId === undefined ? {} : { tabId: state.tabId }),
      }),
    ).catch((error: unknown) =>
      fail(errorOutcome(error), "browser", safeErrorMessage(error, pairingToken)),
    );
    state.finalSnapshot = finalSnapshot;
    state.diagnostics = diagnosticsFromSnapshot(finalSnapshot);
    if (originOf(finalSnapshot.url) !== validatedOrigin) {
      fail("failed", "browser", "The scenario redirected the controlled tab to another origin.");
    }
    state.assertionResults = input.scenario.assertions.map((assertion) =>
      evaluateAssertion(finalSnapshot, assertion),
    );
    if (
      state.assertionResults.length === 0 ||
      state.assertionResults.some((assertion) => !assertion.passed)
    ) {
      fail("failed", "browser", "Observable browser assertions were missing or failed.");
    }

    if (requiredMedia(input.scenario, "recording")) {
      const artifact = await Effect.runPromise(
        dependencies.broker.invoke<PreviewAutomationRecordingArtifact>({
          scope,
          operation: "recordingStop",
          input: {},
          ...(state.tabId === undefined ? {} : { tabId: state.tabId }),
        }),
      ).catch((error: unknown) => fail(errorOutcome(error), "media", safeMessage(error)));
      recordingStopped = true;
      const bytes = await readRecording(dependencies, artifact).catch((error: unknown) =>
        fail(errorOutcome(error), "media", safeMessage(error)),
      );
      const decoder =
        dependencies.recordingDecoder ??
        (state.tabId === undefined
          ? undefined
          : defaultSmallRecordingDecoder(dependencies.broker, scope, state.tabId));
      const recordingInput = {
        identity: state.identity,
        media: { kind: "recording", mimeType: artifact.mimeType, bytes },
        ...(dependencies.mediaPersistence === undefined
          ? {}
          : { persistence: dependencies.mediaPersistence }),
        ...(decoder === undefined ? {} : { decoder }),
      } as const;
      const recording = await validateBrowserValidationMedia(recordingInput).catch(
        (error: unknown) => fail(errorOutcome(error), "media", safeMessage(error)),
      );
      state.media.push(recording);
    }

    if (requiredMedia(input.scenario, "screenshot")) {
      const screenshot = await validateBrowserValidationMedia({
        identity: state.identity,
        media: {
          kind: "screenshot",
          mimeType: finalSnapshot.screenshot.mimeType,
          bytes: strictBase64(finalSnapshot.screenshot.data),
          width: finalSnapshot.screenshot.width,
          height: finalSnapshot.screenshot.height,
        },
        ...(dependencies.mediaPersistence === undefined
          ? {}
          : { persistence: dependencies.mediaPersistence }),
      }).catch((error: unknown) => fail(errorOutcome(error), "media", safeMessage(error)));
      state.media.push(screenshot);
    }

    if (
      (requiredMedia(input.scenario, "screenshot") &&
        !state.media.some((media) => media.kind === "screenshot")) ||
      (requiredMedia(input.scenario, "recording") &&
        !state.media.some((media) => media.kind === "recording"))
    ) {
      fail("failed", "media", "Required browser evidence was not produced.");
    }
    outcome = "passed";
  } catch (error) {
    const abort =
      error instanceof BrowserValidationAbort
        ? error
        : new BrowserValidationAbort("failed", "browser", safeMessage(error));
    if (recordingStarted && !recordingStopped) {
      recordingStopped = true;
      await Effect.runPromise(
        dependencies.broker.invoke<PreviewAutomationRecordingArtifact>({
          scope,
          operation: "recordingStop",
          input: {},
          ...(state.tabId === undefined ? {} : { tabId: state.tabId }),
        }),
      ).catch((stopError: unknown) => {
        state.extraDiagnostics.push(
          diagnosticFromError("media", new Error(safeMessage(stopError))),
        );
      });
    }
    state.extraDiagnostics.push(diagnosticFromError(abort.kind, abort));
    outcome = abort.outcome;
  } finally {
    if (issuedCredentialId !== undefined) {
      await Effect.runPromise(dependencies.credentials.revoke(issuedCredentialId)).catch(
        (revokeError: unknown) => {
          state.extraDiagnostics.push({
            kind: "persistence",
            message: safeErrorMessage(revokeError, pairingToken),
          });
        },
      );
    }
    pairingToken = "";
  }
  return makeResult(state, outcome);
};

export const executeBrowserValidation = (
  dependencies: BrowserValidationExecutorDependencies,
  input: BrowserValidationExecutionInput,
): Effect.Effect<BrowserValidationResult> =>
  Effect.promise(() => executePromise(dependencies, input));

export const makeBrowserValidationExecutor = Effect.gen(function* () {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const credentials = yield* BootstrapCredentialService.BootstrapCredentialService;
  return {
    execute: (input) =>
      executeBrowserValidation(
        {
          broker,
          credentials,
          recordingDecoder: ffprobeBrowserValidationRecordingDecoder(),
        },
        input,
      ),
  } satisfies BrowserValidationExecutorShape;
});

export const BrowserValidationExecutorLive = Layer.effect(
  BrowserValidationExecutor,
  makeBrowserValidationExecutor,
);
