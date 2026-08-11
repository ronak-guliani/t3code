import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestReviewCapabilities,
  PullRequestReviewerCapabilities,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { type ProviderChangeRequest, type PullRequestProviderApi } from "./PullRequestProvider.ts";
import { PullRequestProviderRegistry, fromProviders } from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";

const FULL_REVIEW: PullRequestReviewCapabilities = {
  inlineComment: true,
  reply: true,
  resolve: true,
  verdicts: ["comment", "approve", "request-changes"],
};

const FULL_REVIEWERS: PullRequestReviewerCapabilities = { request: true, listCandidates: true };

const project: OrchestrationProjectShell = {
  id: "project-1" as ProjectId,
  title: "Web",
  workspaceRoot: "/workspace/web",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/web",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/web.git",
    },
    provider: "github",
    displayName: "acme/web",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-10T00:00:00Z",
  updatedAt: "2026-08-10T00:00:00Z",
};

const teamRequestedChange: ProviderChangeRequest = {
  number: 42,
  title: "Review me",
  url: "https://github.com/acme/web/pull/42",
  author: { login: "octocat", name: null, avatarUrl: null },
  headBranch: "feature/review",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  createdAt: "2026-08-10T00:00:00Z",
  updatedAt: "2026-08-10T01:00:00Z",
  reviewRequestLogins: [],
  hasTeamReviewRequest: true,
  labels: [],
};

function provider(): PullRequestProviderApi {
  return providerWith();
}

function providerWith(overrides: Partial<PullRequestProviderApi> = {}): PullRequestProviderApi {
  return {
    kind: "github",
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge", "ready", "draft", "close", "reopen"],
      mergeMethods: ["merge", "squash", "rebase"],
      search: true,
      review: FULL_REVIEW,
      reviewers: FULL_REVIEWERS,
    },
    getViewer: () => Effect.succeed("bilal"),
    listChangeRequests: () =>
      Effect.succeed({ items: [teamRequestedChange], truncated: false, continues: true }),
    getChangeRequest: () => Effect.die("unused"),
    getChangeRequestActivity: () => Effect.die("unused"),
    getViewerPermissions: () =>
      Effect.succeed({
        actions: ["merge", "ready", "draft", "close", "reopen"],
        comment: true,
        resolve: true,
        verdicts: ["comment", "approve", "request-changes"],
        requestReviewers: true,
      }),
    getDiff: () => Effect.die("unused"),
    runAction: () => Effect.void,
    comment: () => Effect.void,
    submitReview: () => Effect.void,
    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
    setReviewerRequest: () => Effect.void,
    replyToThread: () => Effect.void,
    setThreadResolution: () => Effect.void,
    ...overrides,
  };
}

function makeService(
  input: {
    readonly project?: OrchestrationProjectShell;
    readonly provider?: PullRequestProviderApi;
  } = {},
) {
  return PullRequestService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(PullRequestProviderRegistry, fromProviders([input.provider ?? provider()])),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [input.project ?? project],
              threads: [],
              updatedAt: "2026-08-10T00:00:00Z",
            }),
        }),
      ),
    ),
  );
}

it.effect("marks a team request only on a server-selected Reviewing result", () =>
  Effect.gen(function* () {
    const service = yield* makeService();

    const all = yield* service.list({ state: "open", involvement: "all" });
    const reviewing = yield* service.list({ state: "open", involvement: "reviewing" });

    assert.strictEqual(all.entries[0]?.viewerReviewRequested, false);
    assert.strictEqual(reviewing.entries[0]?.viewerReviewRequested, true);
  }),
);

it.effect("refuses a mutation that names a repository outside the selected project", () =>
  Effect.gen(function* () {
    const service = yield* makeService();

    const error = yield* service
      .comment({
        projectId: project.id,
        repository: "attacker/repository",
        number: 42,
        body: "Please merge this.",
      })
      .pipe(Effect.flip);

    if (error._tag !== "PullRequestOperationError") {
      assert.fail(`Expected PullRequestOperationError, got ${error._tag}`);
    }
    assert.strictEqual(error.operation, "resolveRepository");
  }),
);

it.effect("does not read a path that was not proven to be in the pull request diff", () =>
  Effect.gen(function* () {
    let fileContentsCalls = 0;
    const service = yield* makeService({
      provider: providerWith({
        getDiff: () =>
          Effect.succeed({
            patch: [
              "diff --git a/src/other.ts b/src/other.ts",
              "--- a/src/other.ts",
              "+++ b/src/other.ts",
            ].join("\n"),
            truncated: false,
            nextCursor: null,
          }),
        getDiffFileContents: () => {
          fileContentsCalls += 1;
          return Effect.succeed({ oldContents: "", newContents: "" });
        },
      }),
    });

    const error = yield* service
      .diffFileContents({
        projectId: project.id,
        repository: "acme/web",
        number: 42,
        changeType: "new",
        oldPath: "README.md",
        newPath: "README.md",
      })
      .pipe(Effect.flip);

    if (error._tag !== "PullRequestOperationError") {
      assert.fail(`Expected PullRequestOperationError, got ${error._tag}`);
    }
    assert.strictEqual(error.operation, "diffFileContents");
    assert.strictEqual(fileContentsCalls, 0);
  }),
);

it.effect("expands only a file proven in the requested commit diff", () =>
  Effect.gen(function* () {
    const commit = "a".repeat(40);
    const diffInputs: Array<{
      readonly commit?: string | undefined;
      readonly cursor?: string | undefined;
    }> = [];
    const fileInputs: Array<{ readonly commit?: string | undefined }> = [];
    const service = yield* makeService({
      provider: providerWith({
        getDiff: (input) => {
          diffInputs.push(input);
          return Effect.succeed({
            patch:
              input.cursor === undefined
                ? [
                    "diff --git a/src/earlier.ts b/src/earlier.ts",
                    "--- a/src/earlier.ts",
                    "+++ b/src/earlier.ts",
                  ].join("\n")
                : [
                    "diff --git a/src/file.ts b/src/file.ts",
                    "--- a/src/file.ts",
                    "+++ b/src/file.ts",
                    "@@ -1 +1 @@",
                    "-before",
                    "+after",
                  ].join("\n"),
            truncated: false,
            nextCursor: input.cursor === undefined ? "page-2" : null,
          });
        },
        getDiffFileContents: (input) => {
          fileInputs.push(input);
          return Effect.succeed({ oldContents: "before\n", newContents: "after\n" });
        },
      }),
    });

    const result = yield* service.diffFileContents({
      projectId: project.id,
      repository: "acme/web",
      number: 42,
      commit,
      changeType: "change",
      oldPath: "src/file.ts",
      newPath: "src/file.ts",
    });

    assert.deepStrictEqual(result, { oldContents: "before\n", newContents: "after\n" });
    assert.deepStrictEqual(
      diffInputs.map((input) => input.commit),
      [commit, commit],
    );
    assert.deepStrictEqual(
      diffInputs.map((input) => input.cursor),
      [undefined, "page-2"],
    );
    assert.deepStrictEqual(
      fileInputs.map((input) => input.commit),
      [commit],
    );
  }),
);

it.effect("scopes viewer discovery to the project's GitHub host", () =>
  Effect.gen(function* () {
    const viewerInputs: Array<{ readonly cwd: string; readonly host: string }> = [];
    const enterpriseProject: OrchestrationProjectShell = {
      ...project,
      workspaceRoot: "/workspace/enterprise",
      repositoryIdentity: {
        ...project.repositoryIdentity!,
        canonicalKey: "github.example.test/acme/web",
      },
    };
    const service = yield* makeService({
      project: enterpriseProject,
      provider: providerWith({
        getViewer: (input) => {
          viewerInputs.push(input);
          return Effect.succeed("enterprise-user");
        },
      }),
    });

    yield* service.list({ state: "open" });

    assert.deepStrictEqual(viewerInputs, [
      { cwd: "/workspace/enterprise", host: "github.example.test" },
    ]);
  }),
);

it.effect("mutates only review threads proven to belong to the selected pull request", () =>
  Effect.gen(function* () {
    const replies: string[] = [];
    const resolutions: string[] = [];
    const service = yield* makeService({
      provider: providerWith({
        getChangeRequestActivity: () =>
          Effect.succeed({
            comments: [],
            commentCount: 0,
            commentsTruncated: false,
            reviewThreads: [
              {
                id: "thread-on-pr",
                path: "src/file.ts",
                line: 1,
                side: "right",
                isResolved: false,
                isOutdated: false,
                comments: [],
              },
            ],
            commits: [],
          }),
        replyToThread: (input) => {
          replies.push(input.threadId);
          return Effect.void;
        },
        setThreadResolution: (input) => {
          resolutions.push(input.threadId);
          return Effect.void;
        },
      }),
    });

    yield* service.replyToThread({
      projectId: project.id,
      repository: "acme/web",
      number: 42,
      threadId: "thread-on-pr",
      body: "Resolved in the latest commit.",
    });
    yield* service.setThreadResolution({
      projectId: project.id,
      repository: "acme/web",
      number: 42,
      threadId: "thread-on-pr",
      resolved: true,
    });

    const replyError = yield* service
      .replyToThread({
        projectId: project.id,
        repository: "acme/web",
        number: 42,
        threadId: "thread-on-another-pr",
        body: "This must not be sent.",
      })
      .pipe(Effect.flip);
    const resolutionError = yield* service
      .setThreadResolution({
        projectId: project.id,
        repository: "acme/web",
        number: 42,
        threadId: "thread-on-another-pr",
        resolved: true,
      })
      .pipe(Effect.flip);

    assert.deepStrictEqual(replies, ["thread-on-pr"]);
    assert.deepStrictEqual(resolutions, ["thread-on-pr"]);
    assert.strictEqual(replyError._tag, "PullRequestOperationError");
    assert.strictEqual(resolutionError._tag, "PullRequestOperationError");
  }),
);
