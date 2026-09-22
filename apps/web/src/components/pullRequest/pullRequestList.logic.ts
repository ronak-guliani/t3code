import type {
  EnvironmentId,
  PullRequestListCursors,
  PullRequestListResult,
} from "@t3tools/contracts";

export function pullRequestEntryKey(entry: PullRequestListResult["entries"][number]): string {
  return `${entry.projectId}:${entry.repository}#${entry.number}`;
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
