import { Schema } from "effect";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { BrowserNavigationTarget } from "./previewAutomation.ts";
import { PreviewTabId } from "./preview.ts";
import { ValidationTarget } from "./validation.ts";

export const BrowserValidationOutcome = Schema.Literals([
  "passed",
  "failed",
  "blocked",
  "interrupted",
]);
export type BrowserValidationOutcome = typeof BrowserValidationOutcome.Type;

export const BrowserValidationAction = Schema.Struct({
  id: TrimmedNonEmptyString,
  operation: Schema.Literals(["click", "type", "press", "scroll", "evaluate", "waitFor"]),
  input: Schema.Unknown,
});
export type BrowserValidationAction = typeof BrowserValidationAction.Type;

export const BrowserValidationAuthentication = Schema.Struct({
  origin: TrimmedNonEmptyString,
  requiredText: TrimmedNonEmptyString,
  pathPrefix: Schema.optional(TrimmedNonEmptyString),
});
export type BrowserValidationAuthentication = typeof BrowserValidationAuthentication.Type;

export const BrowserValidationAssertion = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["visible-text", "url-origin", "url-path", "title", "not-loading"]),
  expected: Schema.optional(TrimmedNonEmptyString),
});
export type BrowserValidationAssertion = typeof BrowserValidationAssertion.Type;

export const BrowserValidationMediaRequirement = Schema.Struct({
  kind: Schema.Literals(["screenshot", "recording"]),
  required: Schema.Boolean,
});
export type BrowserValidationMediaRequirement = typeof BrowserValidationMediaRequirement.Type;

export const BrowserValidationScenario = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  target: BrowserNavigationTarget,
  authentication: BrowserValidationAuthentication,
  actions: Schema.Array(BrowserValidationAction),
  assertions: Schema.Array(BrowserValidationAssertion),
  media: Schema.Array(BrowserValidationMediaRequirement),
});
export type BrowserValidationScenario = typeof BrowserValidationScenario.Type;

export const BrowserValidationIdentity = Schema.Struct({
  runId: TrimmedNonEmptyString,
  gateId: TrimmedNonEmptyString,
  executorId: TrimmedNonEmptyString,
  threadId: ThreadId,
  revision: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
});
export type BrowserValidationIdentity = typeof BrowserValidationIdentity.Type;

export const BrowserValidationAssertionResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  passed: Schema.Boolean,
  observed: Schema.String,
});
export type BrowserValidationAssertionResult = typeof BrowserValidationAssertionResult.Type;

export const BrowserValidationDiagnostic = Schema.Struct({
  kind: Schema.Literals(["browser", "console", "network", "media", "persistence"]),
  message: TrimmedNonEmptyString,
});
export type BrowserValidationDiagnostic = typeof BrowserValidationDiagnostic.Type;

export const BrowserValidationMediaEvidence = Schema.Struct({
  kind: Schema.Literals(["screenshot", "recording"]),
  mimeType: TrimmedNonEmptyString,
  sizeBytes: Schema.Int,
  width: Schema.Int,
  height: Schema.Int,
  sha256: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  gateId: TrimmedNonEmptyString,
  executorId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  persistedPath: Schema.optional(TrimmedNonEmptyString),
  durationSeconds: Schema.optional(Schema.Finite),
});
export type BrowserValidationMediaEvidence = typeof BrowserValidationMediaEvidence.Type;

export const BrowserValidationFinalSnapshot = Schema.Struct({
  tabId: Schema.optional(PreviewTabId),
  origin: Schema.NullOr(Schema.String),
  url: Schema.String,
  title: Schema.String,
  visibleText: Schema.String,
  loading: Schema.Boolean,
});
export type BrowserValidationFinalSnapshot = typeof BrowserValidationFinalSnapshot.Type;

export const BrowserValidationAppState = Schema.Struct({
  authenticated: Schema.Boolean,
  origin: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
});
export type BrowserValidationAppState = typeof BrowserValidationAppState.Type;

export const BrowserValidationDiagnostics = Schema.Struct({
  console: Schema.Array(BrowserValidationDiagnostic),
  network: Schema.Array(BrowserValidationDiagnostic),
});
export type BrowserValidationDiagnostics = typeof BrowserValidationDiagnostics.Type;

export const BrowserValidationEvidence = Schema.Struct({
  verification: Schema.Literals(["verified", "diagnostic-only"]),
  identity: BrowserValidationIdentity,
  scenarioId: TrimmedNonEmptyString,
  authentication: BrowserValidationAssertionResult,
  assertions: Schema.Array(BrowserValidationAssertionResult),
  finalSnapshot: Schema.NullOr(BrowserValidationFinalSnapshot),
  appState: Schema.NullOr(BrowserValidationAppState),
  diagnostics: BrowserValidationDiagnostics,
  media: Schema.Array(BrowserValidationMediaEvidence),
});
export type BrowserValidationEvidence = typeof BrowserValidationEvidence.Type;

export const BrowserValidationResult = Schema.Struct({
  outcome: BrowserValidationOutcome,
  identity: BrowserValidationIdentity,
  evidence: BrowserValidationEvidence,
  diagnostics: Schema.Array(BrowserValidationDiagnostic),
});
export type BrowserValidationResult = typeof BrowserValidationResult.Type;

export type BrowserValidationExecutionInput = {
  readonly runId: string;
  readonly gateId: string;
  readonly executorId: string;
  readonly target: ValidationTarget;
  readonly environment: ExecutionEnvironmentDescriptor;
  readonly scenario: BrowserValidationScenario;
  readonly threadId: ThreadId;
};
