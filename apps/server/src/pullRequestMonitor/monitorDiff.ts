import type {
  PullRequestMonitorActionableEvent,
  PullRequestMonitorCheckRun,
  PullRequestMonitorSnapshot,
} from "@t3tools/contracts";

export interface PullRequestMonitorCursor {
  readonly headSha: string;
  readonly state: string;
  readonly reviewStates: Readonly<Record<string, string>>;
  readonly threadVersions: Readonly<
    Record<string, { readonly updatedAt: string; readonly resolved: boolean }>
  >;
  readonly issueCommentVersions: Readonly<Record<string, string>>;
  readonly checkRuns: Readonly<
    Record<string, { readonly runId: string; readonly outcome: "success" | "failure" | "pending" }>
  >;
  readonly behindBase: boolean;
  readonly sourceRevision: string;
}

const checkOutcome = (check: PullRequestMonitorCheckRun): "success" | "failure" | "pending" => {
  if (check.status === "pending") return "pending";
  if (
    check.status === "success" ||
    check.status === "neutral" ||
    check.status === "skipped" ||
    check.status === "cancelled"
  ) {
    return "success";
  }
  return "failure";
};

export function emptyCursor(): PullRequestMonitorCursor {
  return {
    headSha: "",
    state: "",
    reviewStates: {},
    threadVersions: {},
    issueCommentVersions: {},
    checkRuns: {},
    behindBase: false,
    sourceRevision: "",
  };
}

export function cursorFromSnapshot(snapshot: PullRequestMonitorSnapshot): PullRequestMonitorCursor {
  return {
    headSha: snapshot.headSha,
    state: snapshot.state,
    reviewStates: Object.fromEntries(snapshot.reviews.map((review) => [review.id, review.state])),
    threadVersions: Object.fromEntries(
      snapshot.reviewThreads.map((thread) => [
        thread.id,
        { updatedAt: thread.updatedAt, resolved: thread.resolved },
      ]),
    ),
    issueCommentVersions: Object.fromEntries(
      snapshot.issueComments.map((comment) => [comment.id, comment.updatedAt]),
    ),
    checkRuns: Object.fromEntries(
      snapshot.checkRuns
        .filter((check) => check.headSha === snapshot.headSha)
        .map((check) => [
          `${check.headSha}::${check.name}::${check.id}`,
          { runId: check.id, outcome: checkOutcome(check) },
        ]),
    ),
    behindBase: (snapshot.behindBaseBy ?? 0) > 0,
    sourceRevision: snapshot.sourceRevision,
  };
}

export function diffPullRequestMonitorSnapshot(
  previousCursor: PullRequestMonitorCursor,
  snapshot: PullRequestMonitorSnapshot,
): {
  readonly actionableEvents: ReadonlyArray<PullRequestMonitorActionableEvent>;
  readonly nextCursor: PullRequestMonitorCursor;
} {
  const actionableEvents: PullRequestMonitorActionableEvent[] = [];

  if (previousCursor.state !== "" && previousCursor.state !== snapshot.state) {
    actionableEvents.push({
      kind: "state-changed",
      detail: `${previousCursor.state} -> ${snapshot.state}`,
    });
  }

  for (const thread of snapshot.reviewThreads) {
    const previous = previousCursor.threadVersions[thread.id];
    const reopened = previous?.resolved === true && !thread.resolved;
    const changedComment =
      !thread.latestCommentByViewer &&
      !thread.resolved &&
      (!previous || previous.updatedAt !== thread.updatedAt);
    if (reopened || changedComment) {
      actionableEvents.push({
        kind: "new-review-comment",
        sourceId: thread.id,
        edited: previous !== undefined,
        detail: thread.bodyExcerpt,
      });
    }
  }

  for (const comment of snapshot.issueComments) {
    const previousUpdatedAt = previousCursor.issueCommentVersions[comment.id];
    if (!previousUpdatedAt || previousUpdatedAt !== comment.updatedAt) {
      actionableEvents.push({
        kind: "new-review-comment",
        sourceId: comment.id,
        edited: previousUpdatedAt !== undefined,
        detail: comment.bodyExcerpt,
      });
    }
  }

  for (const review of snapshot.reviews) {
    if (
      review.commitSha === snapshot.headSha &&
      review.state === "changes-requested" &&
      previousCursor.reviewStates[review.id] !== "changes-requested"
    ) {
      actionableEvents.push({
        kind: "changes-requested-review",
        sourceId: review.id,
        detail: review.bodyExcerpt,
      });
    }
  }

  for (const check of snapshot.checkRuns.filter((item) => item.headSha === snapshot.headSha)) {
    const outcome = checkOutcome(check);
    const key = `${check.headSha}::${check.name}::${check.id}`;
    const previous = previousCursor.checkRuns[key];
    if (outcome === "failure" && previous?.outcome !== "failure") {
      actionableEvents.push({
        kind: "check-failed",
        sourceId: check.id,
        detail: check.name,
      });
    }
  }

  if ((snapshot.behindBaseBy ?? 0) > 0 && !previousCursor.behindBase) {
    actionableEvents.push({ kind: "behind-base" });
  }

  return { actionableEvents, nextCursor: cursorFromSnapshot(snapshot) };
}
