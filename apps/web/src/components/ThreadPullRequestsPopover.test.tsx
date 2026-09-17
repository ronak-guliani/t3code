import type { GitPullRequestAssociation, ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  formatThreadPullRequestSummary,
  resolveThreadPullRequests,
} from "./ThreadPullRequestsPopover";

const pullRequest = (number: number): GitPullRequestAssociation => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  baseBranch: "main",
  headBranch: `feature/${number}`,
  state: "open",
});

const link = (number: number): ThreadPullRequestLink => ({
  pullRequest: pullRequest(number),
  source: "manual",
  linkedAt: `2026-09-15T00:00:0${number - 392}.000Z`,
});

describe("ThreadPullRequestsPopover", () => {
  it("shows the first linked pull request and the number of additional links", () => {
    const pullRequests = resolveThreadPullRequests(
      [link(392), link(393), link(394), link(395)],
      null,
    );

    expect(formatThreadPullRequestSummary(pullRequests)).toBe("#392 + 3");
  });

  it("falls back to the legacy primary pull request for older environments", () => {
    const pullRequests = resolveThreadPullRequests(undefined, pullRequest(392));

    expect(pullRequests).toEqual([pullRequest(392)]);
    expect(formatThreadPullRequestSummary(pullRequests)).toBe("#392");
  });

  it("keeps a distinct legacy primary before newer links", () => {
    const pullRequests = resolveThreadPullRequests(
      [link(393), link(394), link(395)],
      pullRequest(392),
    );

    expect(pullRequests.map(({ number }) => number)).toEqual([392, 393, 394, 395]);
    expect(formatThreadPullRequestSummary(pullRequests)).toBe("#392 + 3");
  });

  it("does not count the legacy primary twice when it is already linked", () => {
    const pullRequests = resolveThreadPullRequests([link(392), link(393)], pullRequest(392));

    expect(pullRequests.map(({ number }) => number)).toEqual([392, 393]);
    expect(formatThreadPullRequestSummary(pullRequests)).toBe("#392 + 1");
  });
});
