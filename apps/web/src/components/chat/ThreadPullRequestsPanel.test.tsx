import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreadPullRequestsPanel } from "./ThreadPullRequestsPanel";

const linkedPullRequest: ThreadPullRequestLink = {
  pullRequest: {
    number: 42,
    title: "Add linked pull request",
    url: "https://github.com/acme/app/pull/42",
    baseBranch: "main",
    headBranch: "feature/linked-pr",
    state: "open",
  },
  source: "manual",
  linkedAt: "2026-09-14T00:00:00.000Z",
};

describe("ThreadPullRequestsPanel", () => {
  it("labels link and unlink controls for assistive technology", () => {
    const html = renderToStaticMarkup(
      <ThreadPullRequestsPanel
        pullRequests={[linkedPullRequest]}
        enabled
        onLink={async () => {}}
        onUnlink={async () => {}}
      />,
    );

    expect(html).toContain('aria-label="Link pull request"');
    expect(html).toContain('aria-label="Unlink pull request #42"');
  });

  it("keeps unsupported clients read-only when linked PRs are present", () => {
    const html = renderToStaticMarkup(
      <ThreadPullRequestsPanel
        pullRequests={[
          linkedPullRequest,
          { ...linkedPullRequest, pullRequest: { ...linkedPullRequest.pullRequest, number: 43 } },
        ]}
        enabled={false}
        onLink={async () => {}}
        onUnlink={async () => {}}
      />,
    );

    expect(html).not.toContain('aria-label="Unlink pull request');
    expect(html).not.toContain('aria-label="Link pull request"');
  });
});
