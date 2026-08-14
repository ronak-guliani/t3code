import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitHubCli } from "../git/Services/GitHubCli.ts";
import { fetchGitHubPullRequestMonitorSnapshot } from "./GitHubPullRequestMonitorSnapshot.ts";

const graphqlResponse = JSON.stringify({
  data: {
    viewer: { login: "me" },
    repository: {
      pullRequest: {
        state: "OPEN",
        isDraft: false,
        merged: false,
        mergeable: "MERGEABLE",
        headRefOid: "head-sha",
        baseRefName: "main",
        headRefName: "feat/x",
        title: "Add monitor",
        url: "https://github.com/acme/app/pull/12",
        reviews: { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } },
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } },
      },
    },
  },
});

const issueComment = (id: number, login: string) => ({
  id,
  user: { login },
  body: `comment ${id}`,
  created_at: "2026-08-11T00:00:00Z",
  updated_at: "2026-08-11T00:00:00Z",
});

/** A full page plus a short page: the walk must not stop at the first page. */
const issueCommentPages = new Map<string, string>([
  ["1", JSON.stringify(Array.from({ length: 100 }, (_, index) => issueComment(index, "reviewer")))],
  ["2", JSON.stringify([issueComment(200, "me"), issueComment(201, "reviewer")])],
]);

const makeGitHubCli = (requested: Array<string>) =>
  Layer.succeed(GitHubCli, {
    execute: (input: { readonly args: ReadonlyArray<string> }) => {
      const target = input.args.at(-1) ?? "";
      requested.push(target);
      if (input.args.includes("graphql")) {
        return Effect.succeed({ stdout: graphqlResponse });
      }
      if (target.includes("/comments?")) {
        const page = new URL(`https://x/${target}`).searchParams.get("page") ?? "1";
        return Effect.succeed({ stdout: issueCommentPages.get(page) ?? "[]" });
      }
      if (target.includes("check-runs")) {
        return Effect.succeed({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) });
      }
      if (target.endsWith("/status")) {
        return Effect.succeed({ stdout: JSON.stringify({ statuses: [], sha: "head-sha" }) });
      }
      return Effect.succeed({ stdout: JSON.stringify({ behind_by: 0 }) });
    },
  } as unknown as GitHubCli["Service"]);

it.effect("pages issue comments and marks our own comments as viewer-authored", () =>
  Effect.gen(function* () {
    const requested: Array<string> = [];
    const snapshot = yield* fetchGitHubPullRequestMonitorSnapshot({
      cwd: "/workspace/app",
      host: "github.com",
      repository: "acme/app",
      number: 12,
    }).pipe(Effect.provide(makeGitHubCli(requested)));

    const commentPages = requested.filter((target) => target.includes("/comments?"));
    assert.deepStrictEqual(
      commentPages.map((target) => new URL(`https://x/${target}`).searchParams.get("page")),
      ["1", "2"],
    );
    assert.strictEqual(snapshot.issueComments.length, 102);
    assert.isTrue(snapshot.completeness.issueCommentsComplete);

    const own = snapshot.issueComments.find((comment) => comment.id === "200");
    assert.isDefined(own);
    assert.isTrue(own?.authoredByViewer);
    const other = snapshot.issueComments.find((comment) => comment.id === "201");
    assert.isFalse(other?.authoredByViewer);
  }),
);

it.effect("reports incomplete issue comments when the page budget is exhausted", () =>
  Effect.gen(function* () {
    const fullPage = JSON.stringify(
      Array.from({ length: 100 }, (_, index) => issueComment(index, "reviewer")),
    );
    const snapshot = yield* fetchGitHubPullRequestMonitorSnapshot({
      cwd: "/workspace/app",
      host: "github.com",
      repository: "acme/app",
      number: 12,
    }).pipe(
      Effect.provide(
        Layer.succeed(GitHubCli, {
          execute: (input: { readonly args: ReadonlyArray<string> }) => {
            const target = input.args.at(-1) ?? "";
            if (input.args.includes("graphql")) {
              return Effect.succeed({ stdout: graphqlResponse });
            }
            if (target.includes("/comments?")) return Effect.succeed({ stdout: fullPage });
            if (target.includes("check-runs")) {
              return Effect.succeed({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) });
            }
            if (target.endsWith("/status")) {
              return Effect.succeed({ stdout: JSON.stringify({ statuses: [], sha: "head-sha" }) });
            }
            return Effect.succeed({ stdout: JSON.stringify({ behind_by: 0 }) });
          },
        } as unknown as GitHubCli["Service"]),
      ),
    );

    assert.isFalse(snapshot.completeness.issueCommentsComplete);
  }),
);
