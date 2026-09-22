import { EnvironmentId, ProjectId, type PullRequestListEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  appendUniquePullRequestEntries,
  isPullRequestListContinuation,
  pullRequestEntryKey,
  reusePullRequestEntries,
} from "./pullRequestList.logic";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");

function entry(number: number): PullRequestListEntry {
  return {
    provider: "github",
    host: "github.com",
    projectId: PROJECT_ID,
    projectTitle: "Acme",
    repository: "acme/web",
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/acme/web/pull/${number}`,
    author: { login: "octocat", name: "The Octocat", avatarUrl: null },
    headBranch: `feature/${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 1,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    viewerReviewRequested: false,
    labels: [],
  };
}

describe("pull request list pagination", () => {
  it("treats cursorless regrown pages as continuations", () => {
    expect(
      isPullRequestListContinuation({
        cursors: {},
        environmentId: ENVIRONMENT_ID,
        regrown: [ENVIRONMENT_ID],
      }),
    ).toBe(true);
  });

  it("appends regrown entries without duplicating the original page", () => {
    const first = entry(1);
    const second = entry(2);

    expect(
      appendUniquePullRequestEntries([first], [first, second]).map((item) => item.number),
    ).toEqual([1, 2]);
  });

  it("reuses unchanged rows while preserving changed nested data", () => {
    const previous: PullRequestListEntry[] = [
      {
        ...entry(1),
        author: { login: "octocat", name: "The Octocat", avatarUrl: null },
        labels: [{ name: "bug", color: "d73a4a" }],
      },
      entry(2),
    ];
    const first = previous[0]!;
    const second = previous[1]!;
    const unchanged: PullRequestListEntry = {
      ...first,
      author: { ...first.author! },
      labels: [{ ...first.labels[0]! }],
    };
    const changed: PullRequestListEntry = {
      ...second,
      author: { ...second.author!, name: "A different Octocat" },
    };

    const reused = reusePullRequestEntries(previous, [unchanged, changed], pullRequestEntryKey);

    expect(reused[0]).toBe(previous[0]);
    expect(reused[1]).toBe(changed);
    expect(reused).not.toBe(previous);
  });

  it("returns the previous array when a refresh only rebuilds nested values", () => {
    const previous: PullRequestListEntry[] = [
      {
        ...entry(1),
        author: { login: "octocat", name: "The Octocat", avatarUrl: null },
        labels: [{ name: "bug", color: "d73a4a" }],
      },
    ];
    const first = previous[0]!;
    const next: PullRequestListEntry[] = [
      {
        ...first,
        author: { ...first.author! },
        labels: [{ ...first.labels[0]! }],
      },
    ];

    expect(reusePullRequestEntries(previous, next, pullRequestEntryKey)).toBe(previous);
  });

  it("keeps host-scoped rows distinct", () => {
    const github = entry(1);
    const enterprise = { ...github, host: "github.example.com" };

    expect(pullRequestEntryKey(github)).not.toBe(pullRequestEntryKey(enterprise));
  });

  it("reuses rows when pagination changes their order", () => {
    const previous = [entry(1), entry(2)];
    const next = [{ ...previous[1]! }, { ...previous[0]! }];

    const reused = reusePullRequestEntries(previous, next, pullRequestEntryKey);

    expect(reused).not.toBe(previous);
    expect(reused).toEqual([previous[1], previous[0]]);
    expect(reused[0]).toBe(previous[1]);
    expect(reused[1]).toBe(previous[0]);
  });
});
