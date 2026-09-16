import { describe, expect, it } from "vitest";
import {
  sameThreadPullRequest,
  sameThreadPullRequestAssociation,
  threadPullRequestKey,
  threadPullRequestSearchTerms,
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

  describe("threadPullRequestSearchTerms", () => {
    const association = {
      ...pullRequest,
      title: "Find linked PR threads",
      baseBranch: "main",
      headBranch: "feat/search",
      state: "open" as const,
    };

    it("includes number, repository-qualified number, URL, and title", () => {
      expect(
        threadPullRequestSearchTerms({
          pullRequests: [{ pullRequest: association, source: "manual", linkedAt: "2026-09-08" }],
        }),
      ).toEqual([
        "#42",
        "acme/app#42",
        "https://github.com/acme/app/pull/42",
        "Find linked PR threads",
      ]);
    });

    it("falls back to the legacy association only when no links exist", () => {
      expect(
        threadPullRequestSearchTerms({ pullRequests: [], pullRequest: association }),
      ).toContain("#42");
      expect(
        threadPullRequestSearchTerms({
          pullRequests: [
            {
              pullRequest: { ...association, number: 43 },
              source: "manual",
              linkedAt: "2026-09-08",
            },
          ],
          pullRequest: association,
        }),
      ).not.toContain("#42");
    });
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
