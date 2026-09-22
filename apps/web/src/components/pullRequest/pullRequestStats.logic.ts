import type { EnvironmentId, ProjectId, PullRequestListEntry } from "@t3tools/contracts";

export type PullRequestStatsEntry = PullRequestListEntry & {
  readonly environmentId: EnvironmentId;
};

export type PullRequestStatsPolicy = "visible" | "eager";

export type PullRequestDiffStats = ReadonlyMap<
  string,
  { readonly additions: number; readonly deletions: number }
>;

export interface PullRequestStatsBatch {
  readonly environmentId: EnvironmentId;
  readonly refs: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly repository: string;
    readonly number: number;
  }>;
  readonly keys: ReadonlySet<string>;
}

const MAX_PULL_REQUEST_STATS_REFS = 500;

export function pullRequestStatsKey(entry: PullRequestStatsEntry): string {
  return `${entry.environmentId}:${entry.projectId}:${entry.repository}#${entry.number}`;
}

export function pullRequestDiffStatKey(row: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
}): string {
  return `${row.environmentId}:${row.projectId}:${row.repository}#${row.number}`;
}

export function mergePullRequestDiffStats(
  previous: PullRequestDiffStats,
  stats: ReadonlyArray<{
    readonly environmentId: string;
    readonly projectId: string;
    readonly repository: string;
    readonly number: number;
    readonly additions: number;
    readonly deletions: number;
  }>,
): PullRequestDiffStats {
  if (stats.length === 0) return previous;
  let changed = false;
  const next = new Map(previous);
  for (const stat of stats) {
    const key = pullRequestDiffStatKey(stat);
    const value = { additions: stat.additions, deletions: stat.deletions };
    const previousValue = previous.get(key);
    if (
      previousValue?.additions !== value.additions ||
      previousValue?.deletions !== value.deletions
    ) {
      next.set(key, value);
      changed = true;
    }
  }
  return changed ? next : previous;
}

export function decoratePullRequestEntriesWithStats<Entry extends PullRequestStatsEntry>(
  entries: ReadonlyArray<Entry>,
  statsByRow: PullRequestDiffStats,
): ReadonlyArray<Entry> {
  let changed = false;
  const decorated = entries.map((entry) => {
    const stat = statsByRow.get(pullRequestDiffStatKey(entry));
    if (
      stat !== undefined &&
      entry.additions === 0 &&
      entry.deletions === 0 &&
      (entry.additions !== stat.additions || entry.deletions !== stat.deletions)
    ) {
      changed = true;
      return { ...entry, ...stat };
    }
    return entry;
  });
  return changed ? decorated : entries;
}

export function pullRequestStatsBatches(
  entriesByKey: ReadonlyMap<string, PullRequestStatsEntry>,
  keys: ReadonlySet<string>,
): ReadonlyArray<PullRequestStatsBatch> {
  const byEnvironment = new Map<
    EnvironmentId,
    Array<{
      readonly key: string;
      readonly ref: PullRequestStatsBatch["refs"][number];
    }>
  >();
  for (const key of keys) {
    const entry = entriesByKey.get(key);
    if (entry === undefined) continue;
    const rows = byEnvironment.get(entry.environmentId) ?? [];
    rows.push({
      key,
      ref: {
        projectId: entry.projectId,
        repository: entry.repository,
        number: entry.number,
      },
    });
    byEnvironment.set(entry.environmentId, rows);
  }
  return [...byEnvironment].flatMap(([environmentId, rows]) => {
    const batches: PullRequestStatsBatch[] = [];
    for (let index = 0; index < rows.length; index += MAX_PULL_REQUEST_STATS_REFS) {
      const batch = rows.slice(index, index + MAX_PULL_REQUEST_STATS_REFS);
      batches.push({
        environmentId,
        refs: batch.map((row) => row.ref),
        keys: new Set(batch.map((row) => row.key)),
      });
    }
    return batches;
  });
}

export function pullRequestStatsRequestBatches({
  entriesByKey,
  candidateKeys,
  policy,
  activeBatches,
  statsByRow,
  refresh = false,
}: {
  readonly entriesByKey: ReadonlyMap<string, PullRequestStatsEntry>;
  readonly candidateKeys: ReadonlySet<string>;
  readonly policy: PullRequestStatsPolicy;
  readonly activeBatches: ReadonlyArray<PullRequestStatsBatch>;
  readonly statsByRow: PullRequestDiffStats;
  readonly refresh?: boolean;
}): ReadonlyArray<PullRequestStatsBatch> {
  const requestedKeys = policy === "eager" ? new Set(entriesByKey.keys()) : candidateKeys;
  const requested = new Set(activeBatches.flatMap((batch) => [...batch.keys]));
  const keys = refresh
    ? requestedKeys
    : new Set(
        [...requestedKeys].filter((key) => {
          const entry = entriesByKey.get(key);
          return (
            entry !== undefined &&
            !requested.has(key) &&
            !statsByRow.has(pullRequestDiffStatKey(entry))
          );
        }),
      );
  return pullRequestStatsBatches(entriesByKey, keys);
}

export function retainVisiblePullRequestStatsBatches(
  batches: ReadonlyArray<PullRequestStatsBatch>,
  visibleKeys: ReadonlySet<string>,
): ReadonlyArray<PullRequestStatsBatch> {
  return batches.filter((batch) => [...batch.keys].some((key) => visibleKeys.has(key)));
}
