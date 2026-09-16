import { describe, expect, it } from "vitest";
import {
  sameThreadPullRequest,
  sameThreadPullRequestAssociation,
  threadPullRequestKey,
} from "./threadPullRequests.js";

const pullRequest = {
  number: 42,
  url: "https://github.com/acme/app/pull/42",
} as const;

describe("thread pull request identity", () => {
  it("normalizes URL-derived repository identity", () => {
    expect(threadPullRequestKey(pullRequest)).toBe("github.com/acme/app#42");
    expect(
      sameThreadPullRequest(pullRequest, {
        ...pullRequest,
        url: "https://github.com/acme/app/pulls/42",
      }),
    ).toBe(true);
  });

  it("uses the final pull-request marker in repository paths", () => {
    expect(
      threadPullRequestKey({
        ...pullRequest,
        url: "https://github.com/acme/pull/pull/42",
      }),
    ).toBe("github.com/acme/pull#42");
  });

  it("recognizes Azure DevOps pullrequest URLs", () => {
    expect(
      threadPullRequestKey({
        ...pullRequest,
        url: "https://dev.azure.com/acme/project/_apis/git/repositories/repo/pullrequest/42",
      }),
    ).toBe("dev.azure.com/acme/project/_apis/git/repositories/repo#42");
  });

  it("keeps non-default ports distinct", () => {
    expect(
      threadPullRequestKey({
        ...pullRequest,
        url: "https://scm.example:8443/acme/app/pull/42",
      }),
    ).not.toBe(
      threadPullRequestKey({
        ...pullRequest,
        url: "https://scm.example:9443/acme/app/pull/42",
      }),
    );
  });

  it("treats canonical URL changes as association updates", () => {
    const association = {
      ...pullRequest,
      title: "PR",
      baseBranch: "main",
      headBranch: "feature",
      state: "open" as const,
    };
    expect(
      sameThreadPullRequestAssociation(association, {
        ...association,
        url: "https://github.com/acme/app/pulls/42",
      }),
    ).toBe(false);
  });
});
