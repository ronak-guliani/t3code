import { describe, expect, it } from "vitest";
import { sameThreadPullRequest, threadPullRequestKey } from "./threadPullRequests.js";

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
});
