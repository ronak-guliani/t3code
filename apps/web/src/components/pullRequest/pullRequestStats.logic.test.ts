import { EnvironmentId, ProjectId, type PullRequestListEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  decoratePullRequestEntriesWithStats,
  mergePullRequestDiffStats,
  pullRequestStatsBatches,
  pullRequestDiffStatKey,
  pullRequestStatsKey,
  pullRequestStatsRequestBatches,
  retainVisiblePullRequestStatsBatches,
  type PullRequestStatsEntry,
} from "./pullRequestStats.logic";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");

function entry(number: number, environmentId = ENVIRONMENT_ID): PullRequestStatsEntry {
  return {
    environmentId,
    provider: "github",
    host: "github.com",
    projectId: PROJECT_ID,
    projectTitle: "T3 Code",
    repository: "t3tools/t3code",
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    author: { login: "octocat", name: "The Octocat", avatarUrl: null },
    headBranch: `feature/${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 0,
    deletions: 0,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    viewerReviewRequested: false,
    labels: [],
  } satisfies PullRequestListEntry & { environmentId: EnvironmentId };
}

describe("pull request stats batching", () => {
  it("requests only visible candidates for non-size sorts", () => {
    const entries = [entry(1), entry(2), entry(3)];
    const entriesByKey = new Map(entries.map((item) => [pullRequestStatsKey(item), item]));
    const visibleKey = pullRequestStatsKey(entries[1]!);

    const batches = pullRequestStatsRequestBatches({
      entriesByKey,
      candidateKeys: new Set([visibleKey]),
      policy: "visible",
      activeBatches: [],
      statsByRow: new Map(),
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]?.refs.map((ref) => ref.number)).toEqual([2]);
  });

  it("requests every loaded row for size sorts", () => {
    const entries = [entry(1), entry(2), entry(3, EnvironmentId.make("environment-2"))];
    const entriesByKey = new Map(entries.map((item) => [pullRequestStatsKey(item), item]));

    const batches = pullRequestStatsRequestBatches({
      entriesByKey,
      candidateKeys: new Set([pullRequestStatsKey(entries[0]!)]),
      policy: "eager",
      activeBatches: [],
      statsByRow: new Map(),
    });

    expect(batches.map((batch) => batch.environmentId)).toEqual([
      ENVIRONMENT_ID,
      EnvironmentId.make("environment-2"),
    ]);
    expect(batches.flatMap((batch) => batch.refs.map((ref) => ref.number))).toEqual([1, 2, 3]);
  });

  it("keeps batches bounded to the stats endpoint limit", () => {
    const entries = Array.from({ length: 501 }, (_, index) => entry(index + 1));
    const entriesByKey = new Map(entries.map((item) => [pullRequestStatsKey(item), item]));
    const batches = pullRequestStatsBatches(
      entriesByKey,
      new Set(entries.map(pullRequestStatsKey)),
    );

    expect(batches.map((batch) => batch.refs.length)).toEqual([500, 1]);
  });

  it("retains only batches that still intersect the visible window", () => {
    const entries = [entry(1), entry(2), entry(3)];
    const entriesByKey = new Map(entries.map((item) => [pullRequestStatsKey(item), item]));
    const batches = entries.map(
      (item) => pullRequestStatsBatches(entriesByKey, new Set([pullRequestStatsKey(item)]))[0]!,
    );

    const retained = retainVisiblePullRequestStatsBatches(
      batches,
      new Set([pullRequestStatsKey(entries[1]!), pullRequestStatsKey(entries[2]!)]),
    );

    expect(retained.flatMap((batch) => batch.refs.map((ref) => ref.number))).toEqual([2, 3]);
  });

  it("keeps stats distinct for same-number pull requests in different repositories", () => {
    const stats = mergePullRequestDiffStats(new Map(), [
      {
        environmentId: ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        repository: "t3tools/first",
        number: 1,
        additions: 1,
        deletions: 2,
      },
      {
        environmentId: ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        repository: "t3tools/second",
        number: 1,
        additions: 3,
        deletions: 4,
      },
    ]);

    expect(
      stats.get(
        pullRequestDiffStatKey({
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          repository: "t3tools/first",
          number: 1,
        }),
      ),
    ).toEqual({ additions: 1, deletions: 2 });
    expect(
      stats.get(
        pullRequestDiffStatKey({
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          repository: "t3tools/second",
          number: 1,
        }),
      ),
    ).toEqual({ additions: 3, deletions: 4 });
  });

  it("decorates only rows whose deferred stats changed", () => {
    const entries = [entry(1), { ...entry(2), additions: 4, deletions: 2 }];
    const stats = new Map([
      [pullRequestDiffStatKey(entries[0]!), { additions: 8, deletions: 5 }],
      [pullRequestDiffStatKey(entries[1]!), { additions: 9, deletions: 9 }],
    ]);

    const decorated = decoratePullRequestEntriesWithStats(entries, stats);

    expect(decorated[0]).not.toBe(entries[0]);
    expect(decorated[0]).toMatchObject({ additions: 8, deletions: 5 });
    expect(decorated[1]).toBe(entries[1]);
  });

  it("returns the same rows when deferred stats add no visible change", () => {
    const entries = [entry(1)];
    const stats = new Map([[pullRequestDiffStatKey(entries[0]!), { additions: 0, deletions: 0 }]]);

    expect(decoratePullRequestEntriesWithStats(entries, stats)).toBe(entries);
  });
});
