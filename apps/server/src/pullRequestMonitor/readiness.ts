import type {
  PullRequestMonitorBlocker,
  PullRequestMonitorReadiness,
  PullRequestMonitorSnapshot,
} from "@t3tools/contracts";

import type { PullRequestMonitorCursor } from "./monitorDiff.ts";

/**
 * Deterministic server readiness. `ready-to-merge` requires known required-check coverage;
 * otherwise a green board is only `no-known-blockers`.
 */
export function computeReadiness(
  snapshot: PullRequestMonitorSnapshot,
  previousThreadVersions: PullRequestMonitorCursor["threadVersions"] = {},
  monitoringStartedAt?: string,
): PullRequestMonitorReadiness {
  const blockers: PullRequestMonitorBlocker[] = [];

  if (snapshot.state !== "open") {
    blockers.push({ kind: "terminal", detail: snapshot.state });
  }
  if (snapshot.isDraft) {
    blockers.push({ kind: "draft" });
  }
  if (snapshot.mergeability !== "mergeable") {
    blockers.push({ kind: "mergeability", detail: snapshot.mergeability });
  }

  const currentChecks = snapshot.checkRuns.filter((check) => check.headSha === snapshot.headSha);
  if (currentChecks.length === 0) {
    blockers.push({ kind: "checks-missing" });
  }
  for (const check of currentChecks) {
    if (check.status === "pending") {
      blockers.push({ kind: "check-pending", detail: check.name });
    } else if (
      check.status !== "success" &&
      check.status !== "neutral" &&
      check.status !== "skipped" &&
      check.status !== "cancelled"
    ) {
      blockers.push({ kind: "check-failed", detail: check.name });
    }
  }

  const latestOpinionated = new Map<string, (typeof snapshot.reviews)[number]>();
  for (const review of snapshot.reviews) {
    if (review.state !== "changes-requested" && review.state !== "approved") continue;
    const previous = latestOpinionated.get(review.author.login);
    if (previous === undefined || (review.submittedAt ?? "") > (previous.submittedAt ?? "")) {
      latestOpinionated.set(review.author.login, review);
    }
  }
  for (const review of latestOpinionated.values()) {
    if (review.state === "changes-requested") {
      blockers.push({ kind: "changes-requested", detail: review.author.login });
    }
  }

  for (const thread of snapshot.reviewThreads) {
    const previous = previousThreadVersions[thread.id];
    const changedSinceStart =
      monitoringStartedAt === undefined ||
      thread.updatedAt > monitoringStartedAt ||
      (previous?.resolved === true && !thread.resolved);
    if (!thread.resolved && changedSinceStart) {
      blockers.push({ kind: "unresolved-thread", detail: thread.id });
    }
  }

  if ((snapshot.behindBaseBy ?? 0) > 0) {
    blockers.push({ kind: "behind-base", detail: String(snapshot.behindBaseBy) });
  }

  const evidenceSupportsReadyLabel =
    snapshot.completeness.requiredChecksKnown &&
    snapshot.completeness.checksComplete &&
    currentChecks.length > 0;

  if (blockers.length > 0) {
    return { ready: false, label: "blocked", blockers };
  }

  return {
    ready: true,
    label: evidenceSupportsReadyLabel ? "ready-to-merge" : "no-known-blockers",
    blockers: [],
  };
}

export function formatBlockersSummary(readiness: PullRequestMonitorReadiness): string {
  if (readiness.ready) return readiness.label;
  if (readiness.blockers.length === 0) return "blocked";
  return readiness.blockers
    .slice(0, 8)
    .map((blocker) => (blocker.detail ? `${blocker.kind}:${blocker.detail}` : blocker.kind))
    .join(", ");
}
