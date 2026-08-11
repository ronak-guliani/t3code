import { describe, expect, it } from "vitest";

import { githubPullRequestNavigation } from "./openPullRequestLink";

describe("githubPullRequestNavigation", () => {
  it("recognizes a GitHub pull request URL", () => {
    expect(githubPullRequestNavigation("https://github.com/t3tools/t3code/pull/4849")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 4849,
      url: "https://github.com/t3tools/t3code/pull/4849",
    });
  });

  it("recognizes Enterprise pull request URLs", () => {
    expect(
      githubPullRequestNavigation("https://github.example.com/t3tools/t3code/pull/4849"),
    ).toMatchObject({
      host: "github.example.com",
      repository: "t3tools/t3code",
      number: 4849,
    });
  });

  it("does not capture non-pull request URLs", () => {
    expect(
      githubPullRequestNavigation("https://gitlab.com/t3tools/t3code/-/merge_requests/4849"),
    ).toBeNull();
  });
});
