import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitHubCli } from "../git/Services/GitHubCli.ts";
import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import type {
  GitHubPullRequestActivity,
  GitHubPullRequestDetail,
} from "./gitHubPullRequestJson.ts";

const unusedGitHubCli = Layer.succeed(GitHubCli, {
  execute: () => Effect.die("GitHubCli.execute should not be called"),
} as unknown as GitHubCli["Service"]);

const pullRequestActivity: GitHubPullRequestActivity = {
  author: null,
  comments: [
    {
      id: "issue-comment-1",
      kind: "issue-comment",
      author: null,
      body: "Please take another look.",
      createdAt: "2026-08-10T00:00:00Z",
      url: null,
      path: null,
      reviewState: null,
    },
  ],
  commits: [],
};

it.effect("reports a strict comment-count lower bound when review-thread loading fails", () =>
  Effect.gen(function* () {
    const provider = yield* GitHubPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          unusedGitHubCli,
          Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
            getPullRequestActivity: () => Effect.succeed(pullRequestActivity),
            listReviewThreadComments: () =>
              Effect.fail(
                new GitHubPullRequestCli.GitHubPullRequestReadError({
                  command: "gh",
                  cwd: "/workspace/web",
                  operation: "listReviewThreadComments",
                  cause: new Error("GitHub GraphQL unavailable"),
                }),
              ),
          }),
        ),
      ),
    );

    const activity = yield* provider.getChangeRequestActivity({
      cwd: "/workspace/web",
      repository: "acme/web",
      host: "github.com",
      number: 42,
    });

    assert.strictEqual(activity.comments.length, 1);
    assert.strictEqual(activity.commentsTruncated, true);
    assert.strictEqual(activity.commentCount, 2);
  }),
);

it.effect("reports a strict comment-count lower bound when review-thread loading is capped", () =>
  Effect.gen(function* () {
    const provider = yield* GitHubPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          unusedGitHubCli,
          Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
            getPullRequestActivity: () => Effect.succeed(pullRequestActivity),
            listReviewThreadComments: () =>
              Effect.succeed({
                comments: [],
                reviewThreads: [],
                commentCount: 0,
                truncated: true,
                reviewers: [],
                avatarsByLogin: new Map<string, string>(),
                commitStats: new Map<
                  string,
                  { readonly additions: number; readonly deletions: number }
                >(),
                commits: [],
                viewer: { canUpdate: true, didAuthor: false },
              }),
          }),
        ),
      ),
    );

    const activity = yield* provider.getChangeRequestActivity({
      cwd: "/workspace/web",
      repository: "acme/web",
      host: "github.com",
      number: 42,
    });

    assert.strictEqual(activity.comments.length, 1);
    assert.strictEqual(activity.commentsTruncated, true);
    assert.strictEqual(activity.commentCount, 2);
  }),
);

const pullRequestDetail: GitHubPullRequestDetail = {
  authorId: null,
  number: 42,
  title: "Review me",
  url: "https://github.com/acme/web/pull/42",
  author: null,
  headBranch: "feature/review",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  createdAt: "2026-08-10T00:00:00Z",
  updatedAt: "2026-08-10T01:00:00Z",
  reviewRequestLogins: ["bilal"],
  hasTeamReviewRequest: false,
  labels: [],
  body: "Please review.",
  changedFiles: 2,
  mergedAt: null,
  closedAt: null,
  checks: [],
};

it.effect("reads merge settings and viewer standing from one combined access read", () =>
  Effect.gen(function* () {
    let viewerAccessCalls = 0;
    const provider = yield* GitHubPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          unusedGitHubCli,
          Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
            getPullRequestDetail: () => Effect.succeed(pullRequestDetail),
            // No getRepositoryAccess mock: a third `gh` read for the merge settings dies here.
            getViewerAccess: () => {
              viewerAccessCalls += 1;
              return Effect.succeed({
                mergeCapabilities: { merge: true, squash: true, rebase: false },
                canWrite: true,
                canUpdate: true,
                didAuthor: false,
              });
            },
          }),
        ),
      ),
    );

    const detail = yield* provider.getChangeRequest({
      cwd: "/workspace/web",
      repository: "acme/web",
      host: "github.com",
      number: 42,
    });

    assert.strictEqual(viewerAccessCalls, 1);
    assert.deepStrictEqual(detail.mergeCapabilities, {
      merge: true,
      squash: true,
      rebase: false,
    });
    assert.deepStrictEqual(detail.reviewers, [{ login: "bilal", name: null, avatarUrl: null }]);
    // WRITE grants merge; authorship is false so every verdict stays available.
    assert.deepStrictEqual(detail.viewerPermissions.actions, [
      "merge",
      "ready",
      "draft",
      "close",
      "reopen",
    ]);
    assert.deepStrictEqual(detail.viewerPermissions.verdicts, [
      "comment",
      "approve",
      "request-changes",
    ]);
  }),
);
