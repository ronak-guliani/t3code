import type { GitResolvedPullRequest, ReviewSnapshot } from "@t3tools/contracts";

/**
 * Legacy PR-review events predate the durable thread association field, but
 * their immutable review snapshot is itself explicit PR provenance.
 */
export function pullRequestFromReviewSnapshot(
  snapshot: ReviewSnapshot | null | undefined,
): GitResolvedPullRequest | undefined {
  if (snapshot?.scope.kind !== "pull-request") {
    return undefined;
  }
  return {
    number: snapshot.scope.number,
    title: snapshot.scope.title,
    url: snapshot.scope.url,
    baseBranch: snapshot.scope.baseBranch,
    headBranch: snapshot.scope.headBranch,
    // Review snapshots did not historically store state. The PR was available
    // when captured, so open is the only safe last-known value for replay.
    state: "open",
  };
}
