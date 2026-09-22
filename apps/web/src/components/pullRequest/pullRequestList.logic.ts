import type {
  EnvironmentId,
  PullRequestListCursors,
  PullRequestListEntry,
  PullRequestListProjectError,
  PullRequestListResult,
} from "@t3tools/contracts";

type ScopedPullRequestEntry = PullRequestListEntry & {
  readonly environmentId?: EnvironmentId;
};

export function pullRequestEntryKey(entry: ScopedPullRequestEntry): string {
  const environment = entry.environmentId === undefined ? "" : `${entry.environmentId}:`;
  return `${environment}${entry.host}:${entry.projectId}:${entry.repository}#${entry.number}`;
}

export function appendUniquePullRequestEntries(
  existing: PullRequestListResult["entries"],
  next: PullRequestListResult["entries"],
): PullRequestListResult["entries"] {
  const seen = new Set(existing.map(pullRequestEntryKey));
  const appended = next.filter((entry) => {
    const key = pullRequestEntryKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return appended.length === 0 ? existing : [...existing, ...appended];
}

export function appendUniquePullRequestErrors(
  existing: PullRequestListResult["errors"],
  next: PullRequestListResult["errors"],
): PullRequestListResult["errors"] {
  const seen = new Set(existing.map((error) => `${error.projectId}:${error.message}`));
  const appended = next.filter((error) => {
    const key = `${error.projectId}:${error.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return appended.length === 0 ? existing : [...existing, ...appended];
}

function pullRequestActorsEqual(
  left: PullRequestListEntry["author"],
  right: PullRequestListEntry["author"],
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.login === right.login && left.name === right.name && left.avatarUrl === right.avatarUrl
  );
}

function pullRequestLabelsEqual(
  left: PullRequestListEntry["labels"],
  right: PullRequestListEntry["labels"],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftLabel = left[index]!;
    const rightLabel = right[index]!;
    if (leftLabel.name !== rightLabel.name || leftLabel.color !== rightLabel.color) {
      return false;
    }
  }
  return true;
}

function pullRequestEntriesEqual(left: PullRequestListEntry, right: PullRequestListEntry): boolean {
  return (
    left.provider === right.provider &&
    left.host === right.host &&
    left.projectId === right.projectId &&
    left.projectTitle === right.projectTitle &&
    left.repository === right.repository &&
    left.number === right.number &&
    left.title === right.title &&
    left.url === right.url &&
    pullRequestActorsEqual(left.author, right.author) &&
    left.headBranch === right.headBranch &&
    left.baseBranch === right.baseBranch &&
    left.state === right.state &&
    left.isDraft === right.isDraft &&
    left.mergeability === right.mergeability &&
    left.additions === right.additions &&
    left.deletions === right.deletions &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.viewerReviewRequested === right.viewerReviewRequested &&
    pullRequestLabelsEqual(left.labels, right.labels)
  );
}

/**
 * Reuses immutable row objects from the previous answer when a refresh carries
 * the same data. The key preserves identity across reordered pages while the
 * typed comparison covers nested author and label data without serializing
 * every row in the refresh loop.
 */
export function reusePullRequestEntries<Entry extends PullRequestListEntry>(
  previous: ReadonlyArray<Entry>,
  next: ReadonlyArray<Entry>,
  keyOf: (entry: Entry) => string,
): ReadonlyArray<Entry> {
  if (previous.length === 0 || next.length === 0) return next;

  const previousByKey = new Map(previous.map((entry) => [keyOf(entry), entry] as const));
  let unchanged = previous.length === next.length;
  const reused = next.map((entry, index) => {
    const previousEntry = previousByKey.get(keyOf(entry));
    if (previousEntry === undefined || !pullRequestEntriesEqual(previousEntry, entry)) {
      unchanged = false;
      return entry;
    }
    if (previous[index] !== previousEntry) {
      unchanged = false;
    }
    return previousEntry;
  });

  return unchanged ? previous : reused;
}

export function reusePullRequestErrors(
  previous: ReadonlyArray<PullRequestListProjectError>,
  next: ReadonlyArray<PullRequestListProjectError>,
): ReadonlyArray<PullRequestListProjectError> {
  if (previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index += 1) {
    const previousError = previous[index]!;
    const nextError = next[index]!;
    if (
      previousError.projectId !== nextError.projectId ||
      previousError.projectTitle !== nextError.projectTitle ||
      previousError.message !== nextError.message
    ) {
      return next;
    }
  }
  return previous;
}

export function isPullRequestListContinuation(input: {
  readonly cursors: Readonly<Record<string, PullRequestListCursors>> | null;
  readonly environmentId: EnvironmentId;
  readonly regrown: readonly EnvironmentId[];
}): boolean {
  return (
    input.cursors !== null &&
    (input.cursors[input.environmentId] !== undefined ||
      input.regrown.includes(input.environmentId))
  );
}
