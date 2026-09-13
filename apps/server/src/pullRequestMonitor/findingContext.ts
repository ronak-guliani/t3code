import {
  PullRequestMonitorFinding,
  ThreadId,
  type PullRequestMonitorFeedbackRevision,
  type PullRequestMonitorFindingDetail,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Payload = Schema.Struct({
  finding: PullRequestMonitorFinding,
  reviewThreadId: ThreadId,
  contentVersion: Schema.optional(Schema.Literal(1)),
});
const decodePayload = Schema.decodeUnknownOption(Payload);

export function resolveFindingDetail(
  revision: PullRequestMonitorFeedbackRevision,
): PullRequestMonitorFindingDetail {
  const decoded = decodePayload(revision.payload);
  const payload = decoded._tag === "Some" ? decoded.value : null;
  return {
    itemId: revision.itemId,
    revisionId: revision.id,
    reviewedHeadSha: payload?.finding.provenance?.reviewedHeadSha ?? revision.headSha,
    reviewThreadId: payload?.reviewThreadId ?? null,
    contentStatus:
      payload === null
        ? "unavailable"
        : payload.contentVersion === 1
          ? "complete"
          : "legacy-potentially-truncated",
    finding: payload?.finding ?? null,
  };
}

export function formatFindingDetail(detail: PullRequestMonitorFindingDetail): string {
  const header = `Item ${detail.itemId}; revision ${detail.revisionId}; reviewed head ${detail.reviewedHeadSha}; review thread ${detail.reviewThreadId ?? "unknown"}; content ${detail.contentStatus}`;
  if (detail.finding === null) {
    return `${header}\nFinding content unavailable. Do not remediate from the summary; request the original review.`;
  }
  const finding = detail.finding;
  const location = finding.provenance
    ? `${finding.provenance.path}:${finding.provenance.startLine}-${finding.provenance.endLine} (${finding.provenance.side}; diff ${finding.provenance.diffHash}; source ${finding.provenance.findingId})`
    : `${finding.path ?? "unknown"}:${finding.line ?? "unknown"}`;
  return `${header}\n[${finding.severity}] ${finding.title}\n${location}\n${finding.detail}${
    detail.contentStatus === "complete"
      ? ""
      : "\nLegacy content may be truncated. Obtain the original review before remediating."
  }`;
}
/** Each no-tool turn has complete evidence and an immutable retry identity. */
export function findingContextTurns(
  revisions: ReadonlyArray<PullRequestMonitorFeedbackRevision>,
): ReadonlyArray<{
  readonly key: string;
  readonly text: string;
  readonly revisionId: PullRequestMonitorFeedbackRevision["id"];
}> {
  return revisions.map((revision) => ({
    key: `${revision.id}:complete`,
    revisionId: revision.id,
    text: revision.summary.startsWith("review-finding:")
      ? formatFindingDetail(resolveFindingDetail(revision))
      : revision.summary,
  }));
}
