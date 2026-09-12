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
  sampledFrames: Schema.Int,
  distinctFrames: Schema.Int,
  url: Schema.optional(Schema.String),
});
export type SelfTestMedia = typeof SelfTestMedia.Type;

const SelfTestDiagnostics = Schema.Struct({
  pageErrors: Schema.Int,
  failedRequests: Schema.Int,
});

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
  publication: Schema.optional(
    Schema.Struct({
      pullRequestUrl: Schema.String,
    }),
  ),
});
export type SelfTestManifest = typeof SelfTestManifest.Type;

export function selfTestBlockers(
  manifest: SelfTestManifest,
  current: SelfTestRevision,
  requirePublished: boolean,
): ReadonlyArray<string> {
  const blockers: string[] = [];
  if (
    manifest.revision.commit !== current.commit ||
    manifest.revision.contentHash !== current.contentHash
  ) {
    blockers.push("Evidence is stale: the checkout differs from the tested revision.");
  }
  if (manifest.status !== "passed" || manifest.exitCode !== 0 || !manifest.completedAt) {
    blockers.push("The real-client test did not complete successfully.");
  }
  if (manifest.scenarios.length === 0) blockers.push("No observable scenarios were recorded.");
  if (
    !manifest.diagnostics ||
    manifest.diagnostics.pageErrors !== 0 ||
    manifest.diagnostics.failedRequests !== 0
  ) {
    blockers.push("Browser diagnostics are missing or contain unexpected failures.");
  }
  for (const kind of ["screenshot", "recording"] as const) {
    const media = manifest.media.filter((item) => item.kind === kind);
    if (media.length === 0) blockers.push(`Missing ${kind} evidence.`);
    for (const item of media) {
      if (
        item.width <= 0 ||
        item.height <= 0 ||
        item.sizeBytes <= 0 ||
        item.sampledFrames < 1 ||
        (kind === "recording" &&
          (!(item.durationSeconds && item.durationSeconds > 0) ||
            item.sampledFrames < 3 ||
            item.distinctFrames < 2))
      ) {
        blockers.push(`Invalid ${kind} capture.`);
      }
      if (
        requirePublished &&
        !item.url?.startsWith("https://github.com/user-attachments/assets/")
      ) {
        blockers.push(`The ${kind} has not been published.`);
      }
    }
  }
  if (requirePublished && !manifest.publication)
    blockers.push("Evidence has not been attached to a PR.");
  return blockers;
}

export function replaceSelfTestSection(body: string, section: string): string {
  const start = "<!-- t3-self-test:start -->";
  const end = "<!-- t3-self-test:end -->";
  const first = body.indexOf(start);
  const last = body.indexOf(end);
  if (
    first < 0 !== last < 0 ||
    (first >= 0 && last < first) ||
    (first >= 0 && body.indexOf(start, first + start.length) >= 0) ||
    (last >= 0 && body.indexOf(end, last + end.length) >= 0)
  ) {
    throw new Error("The PR contains an ambiguous self-test evidence section.");
  }
  const managed = `${start}\n${section}\n${end}`;
  return first < 0
    ? `${body.trimEnd()}\n\n${managed}\n`
    : `${body.slice(0, first)}${managed}${body.slice(last + end.length)}`;
}
