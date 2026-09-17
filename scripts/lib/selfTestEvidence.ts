import { Schema } from "effect";

export const SelfTestRevision = Schema.Struct({
  commit: Schema.String,
  contentHash: Schema.String,
});
export type SelfTestRevision = typeof SelfTestRevision.Type;

export const SelfTestStage = Schema.Literals([
  "pending",
  "preflight",
  "pairing",
  "assertions",
  "capture",
  "passed",
  "failed",
  "blocked",
  "interrupted",
]);
export type SelfTestStage = typeof SelfTestStage.Type;

export const SelfTestStatus = Schema.Literals([
  "pending",
  "active",
  "blocked",
  "failed",
  "interrupted",
  "passed",
]);
export type SelfTestStatus = typeof SelfTestStatus.Type;

export const SelfTestStatusReport = Schema.Literals([
  "never-run",
  "running",
  "blocked",
  "failed",
  "interrupted",
  "passed",
  "stale-revision",
]);
export type SelfTestStatusReport = typeof SelfTestStatusReport.Type;

export const SelfTestIssueType = Schema.Literals([
  "lock-contention",
  "lock-ambiguous",
  "web-target-missing",
  "web-target-invalid",
  "backend-unhealthy",
  "app-not-served",
  "environment-mismatch",
  "process-start",
  "process-exit",
  "assertion-failed",
  "capture-invalid",
  "diagnostics-failed",
  "interrupted",
  "stale-revision",
  "manifest-invalid",
]);
export type SelfTestIssueType = typeof SelfTestIssueType.Type;

export const SelfTestIssue = Schema.Struct({
  type: SelfTestIssueType,
  message: Schema.String,
  action: Schema.String,
});
export type SelfTestIssue = typeof SelfTestIssue.Type;

export const SelfTestProcess = Schema.Struct({
  role: Schema.Literals(["coordinator", "child"]),
  pid: Schema.Int,
  command: Schema.String,
  startedAt: Schema.String,
});
export type SelfTestProcess = typeof SelfTestProcess.Type;

export const SelfTestEnvironment = Schema.Struct({
  baseDirectory: Schema.String,
  webTarget: Schema.String,
  origin: Schema.optional(Schema.String),
});
export type SelfTestEnvironment = typeof SelfTestEnvironment.Type;

export const SelfTestMedia = Schema.Struct({
  kind: Schema.Literals(["screenshot", "recording"]),
  file: Schema.String,
  sha256: Schema.String,
  sizeBytes: Schema.Int,
  width: Schema.Int,
  height: Schema.Int,
  durationSeconds: Schema.optional(Schema.Finite),
});
export type SelfTestMedia = typeof SelfTestMedia.Type;

export const SelfTestDiagnostics = Schema.Struct({
  pageErrors: Schema.Int,
  failedRequests: Schema.Int,
  consoleErrors: Schema.Int,
  expectedConsoleErrors: Schema.Int,
});
export type SelfTestDiagnostics = typeof SelfTestDiagnostics.Type;

export const SelfTestArtifact = Schema.Struct({
  file: Schema.String,
  sha256: Schema.String,
  sizeBytes: Schema.Int,
});
export type SelfTestArtifact = typeof SelfTestArtifact.Type;

export const SelfTestCapture = Schema.Struct({
  scenarios: Schema.Array(Schema.String),
  media: Schema.Array(SelfTestMedia),
  diagnostics: SelfTestDiagnostics,
});
export type SelfTestCapture = typeof SelfTestCapture.Type;

export const SelfTestStageUpdate = Schema.Struct({
  stage: SelfTestStage,
  scenarios: Schema.optional(Schema.Array(Schema.String)),
  blocker: Schema.optional(SelfTestIssue),
  failure: Schema.optional(SelfTestIssue),
});
export type SelfTestStageUpdate = typeof SelfTestStageUpdate.Type;

export const SelfTestManifest = Schema.Struct({
  version: Schema.Literal(2),
  runId: Schema.String,
  revision: SelfTestRevision,
  status: SelfTestStatus,
  stage: SelfTestStage,
  startedAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
  command: Schema.String,
  process: SelfTestProcess,
  environment: SelfTestEnvironment,
  exitCode: Schema.optional(Schema.Int),
  signal: Schema.optional(Schema.String),
  blocker: Schema.optional(SelfTestIssue),
  failure: Schema.optional(SelfTestIssue),
  scenarios: Schema.Array(Schema.String),
  media: Schema.Array(SelfTestMedia),
  diagnostics: Schema.optional(SelfTestDiagnostics),
  artifacts: Schema.Array(SelfTestArtifact),
});
export type SelfTestManifest = typeof SelfTestManifest.Type;

export type SelfTestLockOwner = {
  readonly pid: number;
  readonly runId: string;
  readonly command: string;
  readonly startedAt: string;
};

export type SelfTestLockState =
  | { readonly status: "missing" }
  | { readonly status: "active"; readonly owner: SelfTestLockOwner }
  | { readonly status: "stale"; readonly owner: SelfTestLockOwner }
  | { readonly status: "ambiguous"; readonly reason: string };

export function classifySelfTestLock(
  owner: SelfTestLockOwner | undefined,
  processAlive: boolean,
  commandMatches: boolean,
): SelfTestLockState {
  if (!owner) return { status: "ambiguous", reason: "The lock owner record is missing." };
  if (processAlive && commandMatches) return { status: "active", owner };
  if (!processAlive) return { status: "stale", owner };
  return {
    status: "ambiguous",
    reason: "The lock PID is alive but does not identify the self-test coordinator.",
  };
}

export function parseSelfTestCommand(args: ReadonlyArray<string>): "run" | "status" {
  const command = args[0] ?? "run";
  if (args.length > 1 || (command !== "run" && command !== "status")) {
    throw new Error(
      "Usage: pnpm test:self -- [run|status]. This command only tests pairing/reconnect. " +
        "Feature reports and publication flags are no longer supported. Exercise the feature " +
        "in a real client and use pnpm pr:media -- <PR URL> <capture files...> to publish its captures.",
    );
  }
  return command;
}

export function redactSelfTestText(value: string): string {
  return value
    .replace(/([?#&](?:token|access_token|credential|authorization)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[redacted]")
    .replace(/(\/pair#token=)[^/\s]+/gi, "$1[redacted]");
}

export function selfTestStatus(
  manifest: SelfTestManifest | undefined,
  current: SelfTestRevision,
): SelfTestStatusReport {
  if (!manifest) return "never-run";
  if (
    manifest.status === "passed" &&
    (manifest.revision.commit !== current.commit ||
      manifest.revision.contentHash !== current.contentHash)
  ) {
    return "stale-revision";
  }
  return manifest.status === "pending" || manifest.status === "active"
    ? "running"
    : manifest.status;
}

export function selfTestBlockers(
  manifest: SelfTestManifest,
  current: SelfTestRevision,
): ReadonlyArray<SelfTestIssue> {
  const blockers: SelfTestIssue[] = [];
  if (
    manifest.revision.commit !== current.commit ||
    manifest.revision.contentHash !== current.contentHash
  ) {
    blockers.push({
      type: "stale-revision",
      message: "The checkout differs from the revision tested by this run.",
      action: "Run pnpm test:self again on the current checkout.",
    });
  }
  if (manifest.status !== "passed" || manifest.exitCode !== 0 || !manifest.completedAt) {
    blockers.push(
      manifest.blocker ??
        manifest.failure ?? {
          type: manifest.status === "blocked" ? "backend-unhealthy" : "assertion-failed",
          message: "The pairing/reconnect smoke test did not complete successfully.",
          action: "Inspect the run artifacts and rerun pnpm test:self after addressing the cause.",
        },
    );
  }
  if (manifest.scenarios.length === 0) {
    blockers.push({
      type: "assertion-failed",
      message: "No pairing/reconnect scenarios were recorded.",
      action: "Ensure the smoke test reaches its assertion and capture stages.",
    });
  }
  if (
    !manifest.diagnostics ||
    manifest.diagnostics.consoleErrors !== 0 ||
    manifest.diagnostics.pageErrors !== 0 ||
    manifest.diagnostics.failedRequests !== 0
  ) {
    blockers.push({
      type: "diagnostics-failed",
      message: "Browser diagnostics are missing or contain unexpected failures.",
      action: "Inspect diagnostics.json and the raw capture before rerunning.",
    });
  }
  for (const kind of ["screenshot", "recording"] as const) {
    const media = manifest.media.filter((item) => item.kind === kind);
    if (media.length === 0) {
      blockers.push({
        type: "capture-invalid",
        message: `Missing baseline ${kind}.`,
        action: "Rerun the self-test and inspect the raw capture directory.",
      });
    }
    for (const item of media) {
      if (
        item.width <= 0 ||
        item.height <= 0 ||
        item.sizeBytes <= 0 ||
        (kind === "recording" && (item.durationSeconds ?? 0) <= 0)
      ) {
        blockers.push({
          type: "capture-invalid",
          message: `Invalid baseline ${kind}.`,
          action: "Inspect the retained raw capture and rerun the self-test.",
        });
      }
    }
  }
  return blockers;
}
