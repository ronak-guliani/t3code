import { EnvironmentId, ProjectId, type PullRequestListEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  appendUniquePullRequestEntries,
  isPullRequestListContinuation,
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
});
