import { Schema } from "effect";

export const SelfTestRevision = Schema.Struct({
  commit: Schema.String,
  contentHash: Schema.String,
});
export type SelfTestRevision = typeof SelfTestRevision.Type;

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

export const SelfTestCapture = Schema.Struct({
  scenarios: Schema.Array(Schema.String),
  media: Schema.Array(SelfTestMedia),
  diagnostics: SelfTestDiagnostics,
});

export const SelfTestManifest = Schema.Struct({
  version: Schema.Literal(1),
  runId: Schema.String,
  revision: SelfTestRevision,
  status: Schema.Literals(["running", "passed", "failed"]),
  startedAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
  command: Schema.String,
  exitCode: Schema.optional(Schema.Int),
  scenarios: Schema.Array(Schema.String),
  media: Schema.Array(SelfTestMedia),
  diagnostics: Schema.optional(SelfTestDiagnostics),
});
export type SelfTestManifest = typeof SelfTestManifest.Type;

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

export function selfTestBlockers(
  manifest: SelfTestManifest,
  current: SelfTestRevision,
): ReadonlyArray<string> {
  const blockers: string[] = [];
  if (
    manifest.revision.commit !== current.commit ||
    manifest.revision.contentHash !== current.contentHash
  ) {
    blockers.push("Baseline is stale: the checkout differs from the tested revision.");
  }
  if (manifest.status !== "passed" || manifest.exitCode !== 0 || !manifest.completedAt) {
    blockers.push("The pairing/reconnect smoke test did not complete successfully.");
  }
  if (manifest.scenarios.length === 0) blockers.push("No baseline scenarios were recorded.");
  if (
    !manifest.diagnostics ||
    manifest.diagnostics.consoleErrors !== 0 ||
    manifest.diagnostics.pageErrors !== 0 ||
    manifest.diagnostics.failedRequests !== 0
  ) {
    blockers.push("Browser diagnostics are missing or contain unexpected failures.");
  }
  for (const kind of ["screenshot", "recording"] as const) {
    const media = manifest.media.filter((item) => item.kind === kind);
    if (media.length === 0) blockers.push(`Missing baseline ${kind}.`);
    for (const item of media) {
      if (
        item.width <= 0 ||
        item.height <= 0 ||
        item.sizeBytes <= 0 ||
        (kind === "recording" && (item.durationSeconds ?? 0) <= 0)
      ) {
        blockers.push(`Invalid baseline ${kind}.`);
      }
    }
  }
  return blockers;
}
