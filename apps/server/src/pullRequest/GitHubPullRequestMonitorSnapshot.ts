import {
  type PullRequestCheckStatus,
  type PullRequestMonitorActor,
  type PullRequestMonitorCheckRun,
  type PullRequestMonitorIssueComment,
  type PullRequestMonitorReview,
  type PullRequestMonitorReviewThread,
  type PullRequestMonitorSnapshot,
  type PullRequestState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as NodeCrypto from "node:crypto";

import type { GitHubCliError } from "@t3tools/contracts";
import { GitHubCli } from "../git/Services/GitHubCli.ts";
import { PullRequestProviderError } from "./PullRequestProvider.ts";

const ActorSchema = Schema.Struct({
  login: Schema.optional(Schema.String),
  __typename: Schema.optional(Schema.String),
});

const ReviewSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(ActorSchema),
  state: Schema.String,
  submittedAt: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
  body: Schema.optional(Schema.String),
});

const ThreadCommentSchema = Schema.Struct({
  author: Schema.NullOr(ActorSchema),
  body: Schema.optional(Schema.String),
  path: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  viewerDidAuthor: Schema.optional(Schema.Boolean),
});

const ThreadSchema = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  comments: Schema.Struct({
    nodes: Schema.Array(ThreadCommentSchema),
  }),
});

const MonitorPageSchema = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            state: Schema.String,
            isDraft: Schema.Boolean,
            merged: Schema.Boolean,
            mergeable: Schema.String,
            headRefOid: Schema.String,
            baseRefName: Schema.String,
            headRefName: Schema.String,
            title: Schema.String,
            url: Schema.String,
            reviews: Schema.Struct({
              nodes: Schema.Array(ReviewSchema),
              pageInfo: Schema.Struct({
                hasNextPage: Schema.Boolean,
              }),
            }),
            reviewThreads: Schema.Struct({
              nodes: Schema.Array(ThreadSchema),
              pageInfo: Schema.Struct({
                hasNextPage: Schema.Boolean,
              }),
            }),
          }),
        ),
      }),
    ),
  }),
});

const IssueCommentsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.Union([Schema.Number, Schema.String]),
    user: Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
        type: Schema.optional(Schema.String),
      }),
    ),
    body: Schema.optional(Schema.String),
    created_at: Schema.String,
    updated_at: Schema.String,
  }),
);

const CheckRunsSchema = Schema.Struct({
  total_count: Schema.Number,
  check_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      head_sha: Schema.String,
      html_url: Schema.optional(Schema.NullOr(Schema.String)),
      output: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            title: Schema.optional(Schema.NullOr(Schema.String)),
            summary: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    }),
  ),
});

const StatusesSchema = Schema.Struct({
  statuses: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        context: Schema.String,
        state: Schema.String,
        description: Schema.NullOr(Schema.String),
        target_url: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  sha: Schema.optional(Schema.String),
});

const CompareSchema = Schema.Struct({
  behind_by: Schema.optional(Schema.Number),
});

const MONITOR_GRAPHQL = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      isDraft
      merged
      mergeable
      headRefOid
      baseRefName
      headRefName
      title
      url
      reviews(last: 100) {
        nodes {
          id
          author { login __typename }
          state
          submittedAt
          commit { oid }
          body
        }
        pageInfo { hasNextPage }
      }
      reviewThreads(last: 100) {
        nodes {
          id
          isResolved
          comments(last: 20) {
            nodes {
              author { login __typename }
              body
              path
              line
              createdAt
              updatedAt
              viewerDidAuthor
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}
`;

function excerpt(value: string | undefined | null, max = 500): string {
  const text = (value ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function actorOf(
  value: { readonly login?: string | undefined; readonly __typename?: string | undefined } | null,
  userType?: string | undefined,
): PullRequestMonitorActor {
  const login = value?.login?.trim() || "ghost";
  if (value?.__typename === "Bot" || userType === "Bot") {
    return { login, kind: "bot" };
  }
  if (login === "ghost") return { login, kind: "unknown" };
  return { login, kind: "user" };
}

function normalizeReviewState(state: string): PullRequestMonitorReview["state"] {
  switch (state.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "DISMISSED":
      return "dismissed";
    case "PENDING":
      return "pending";
    default:
      return "commented";
  }
}

function normalizeCheckStatus(status: string, conclusion: string | null): PullRequestCheckStatus {
  if (status !== "completed") return "pending";
  switch ((conclusion ?? "").toLowerCase()) {
    case "success":
      return "success";
    case "neutral":
      return "neutral";
    case "skipped":
      return "skipped";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "failure";
  }
}

function normalizeLegacyStatus(state: string): PullRequestCheckStatus {
  switch (state.toLowerCase()) {
    case "success":
      return "success";
    case "pending":
      return "pending";
    case "error":
    case "failure":
      return "failure";
    default:
      return "neutral";
  }
}

function pullRequestState(raw: {
  readonly state: string;
  readonly merged: boolean;
}): PullRequestState {
  if (raw.merged || raw.state.toUpperCase() === "MERGED") return "merged";
  if (raw.state.toUpperCase() === "CLOSED") return "closed";
  return "open";
}

function mergeabilityOf(value: string): PullRequestMonitorSnapshot["mergeability"] {
  switch (value.toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

function decodeOrFail<A>(schema: Schema.Codec<A, unknown>, raw: string, operation: string) {
  const decoded = decodeJsonResult(schema)(raw);
  if (Result.isSuccess(decoded)) return Effect.succeed(decoded.success);
  return Effect.fail(
    new PullRequestProviderError({
      provider: "github",
      operation,
      reason: "failed",
      detail: `Unreadable ${operation} response.`,
      cause: decoded.failure,
    }),
  );
}

function sourceRevisionOf(parts: ReadonlyArray<string>): string {
  return NodeCrypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

export const fetchGitHubPullRequestMonitorSnapshot = Effect.fn(
  "fetchGitHubPullRequestMonitorSnapshot",
)(function* (input: {
  readonly cwd: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}) {
  const github = yield* GitHubCli;
  const [owner, ...rest] = input.repository.split("/");
  const name = rest.join("/");
  if (!owner || !name) {
    return yield* Effect.fail(
      new PullRequestProviderError({
        provider: "github",
        operation: "monitorSnapshot",
        reason: "failed",
        detail: `Invalid repository identity: ${input.repository}`,
      }),
    );
  }

  const mapCliError = (error: GitHubCliError) =>
    new PullRequestProviderError({
      provider: "github",
      operation: "monitorSnapshot",
      reason:
        error.detail.includes("required but not available on PATH")
          ? "missing-tool"
          : error.detail.includes("not authenticated")
            ? "unauthenticated"
            : "failed",
      detail: error.detail,
      cause: error,
    });

  const pageRaw = yield* github
    .execute({
      cwd: input.cwd,
      args: [
        "api",
        "graphql",
        "--hostname",
        input.host,
        "-f",
        `query=${MONITOR_GRAPHQL}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${input.number}`,
      ],
    })
    .pipe(Effect.mapError(mapCliError));

  const page = yield* decodeOrFail(MonitorPageSchema, pageRaw.stdout, "monitorSnapshot.graphql");
  const pullRequest = page.data.repository?.pullRequest;
  if (!pullRequest) {
    return yield* Effect.fail(
      new PullRequestProviderError({
        provider: "github",
        operation: "monitorSnapshot",
        reason: "failed",
        detail: `Pull request #${input.number} was not found on ${input.repository}.`,
      }),
    );
  }

  const headSha = pullRequest.headRefOid;
  const [ownerName, repoName] = [owner, name];

  const issueCommentsRaw = yield* github
    .execute({
      cwd: input.cwd,
      args: [
        "api",
        "--hostname",
        input.host,
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${ownerName}/${repoName}/issues/${input.number}/comments?per_page=100`,
      ],
    })
    .pipe(Effect.mapError(mapCliError));
  const issueCommentsDecoded = yield* decodeOrFail(
    IssueCommentsSchema,
    issueCommentsRaw.stdout,
    "monitorSnapshot.issueComments",
  );

  const checkRunsRaw = yield* github
    .execute({
      cwd: input.cwd,
      args: [
        "api",
        "--hostname",
        input.host,
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${ownerName}/${repoName}/commits/${headSha}/check-runs?per_page=100`,
      ],
    })
    .pipe(Effect.mapError(mapCliError));
  const checkRunsDecoded = yield* decodeOrFail(
    CheckRunsSchema,
    checkRunsRaw.stdout,
    "monitorSnapshot.checkRuns",
  );

  const statusesRaw = yield* github
    .execute({
      cwd: input.cwd,
      args: [
        "api",
        "--hostname",
        input.host,
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${ownerName}/${repoName}/commits/${headSha}/status`,
      ],
    })
    .pipe(
      Effect.mapError(mapCliError),
      Effect.orElseSucceed(() => ({ stdout: "{}" })),
    );
  const statusesDecoded = yield* decodeOrFail(
    StatusesSchema,
    statusesRaw.stdout === "" ? "{}" : statusesRaw.stdout,
    "monitorSnapshot.statuses",
  ).pipe(Effect.orElseSucceed(() => ({ statuses: [] as const, sha: headSha })));

  const compareRaw = yield* github
    .execute({
      cwd: input.cwd,
      args: [
        "api",
        "--hostname",
        input.host,
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${ownerName}/${repoName}/compare/${encodeURIComponent(pullRequest.baseRefName)}...${headSha}`,
      ],
    })
    .pipe(
      Effect.mapError(mapCliError),
      Effect.orElseSucceed(() => ({ stdout: "{}" })),
    );
  const compareDecoded = yield* decodeOrFail(
    CompareSchema,
    compareRaw.stdout === "" ? "{}" : compareRaw.stdout,
    "monitorSnapshot.compare",
  ).pipe(Effect.orElseSucceed(() => ({ behind_by: undefined })));

  const reviews: PullRequestMonitorReview[] = pullRequest.reviews.nodes.map((review) => ({
    id: review.id,
    author: actorOf(review.author),
    state: normalizeReviewState(review.state),
    submittedAt: review.submittedAt,
    commitSha: review.commit?.oid ?? null,
    bodyExcerpt: excerpt(review.body),
  }));

  const reviewThreads: PullRequestMonitorReviewThread[] = pullRequest.reviewThreads.nodes.map(
    (thread) => {
      const latest = thread.comments.nodes.at(-1);
      const first = thread.comments.nodes[0];
      return {
        id: thread.id,
        author: actorOf(latest?.author ?? first?.author ?? null),
        path: latest?.path ?? first?.path ?? null,
        line: latest?.line ?? first?.line ?? null,
        createdAt: first?.createdAt ?? latest?.createdAt ?? new Date(0).toISOString(),
        updatedAt: latest?.updatedAt ?? first?.updatedAt ?? new Date(0).toISOString(),
        resolved: thread.isResolved,
        latestCommentByViewer: latest?.viewerDidAuthor === true,
        bodyExcerpt: excerpt(latest?.body ?? first?.body),
      };
    },
  );

  const issueComments: PullRequestMonitorIssueComment[] = issueCommentsDecoded.map((comment) => ({
    id: String(comment.id),
    author: actorOf(comment.user ? { login: comment.user.login } : null, comment.user?.type),
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    bodyExcerpt: excerpt(comment.body),
  }));

  const checkRuns: PullRequestMonitorCheckRun[] = [
    ...checkRunsDecoded.check_runs.map((run) => ({
      id: String(run.id),
      name: run.name,
      status: normalizeCheckStatus(run.status, run.conclusion),
      headSha: run.head_sha,
      url: run.html_url ?? null,
      description: run.output?.title ?? run.output?.summary ?? null,
    })),
    ...(statusesDecoded.statuses ?? []).map((status) => ({
      id: `status:${status.id}`,
      name: status.context,
      status: normalizeLegacyStatus(status.state),
      headSha,
      url: status.target_url,
      description: status.description,
    })),
  ];

  const fetchedAt = new Date().toISOString();
  const state = pullRequestState(pullRequest);
  const sourceRevision = sourceRevisionOf([
    headSha,
    state,
    String(pullRequest.isDraft),
    pullRequest.mergeable,
    ...reviews.map((review) => `${review.id}:${review.state}:${review.submittedAt ?? ""}`),
    ...reviewThreads.map(
      (thread) => `${thread.id}:${thread.updatedAt}:${thread.resolved ? "1" : "0"}`,
    ),
    ...issueComments.map((comment) => `${comment.id}:${comment.updatedAt}`),
    ...checkRuns.map((check) => `${check.id}:${check.status}:${check.headSha}`),
  ]);

  const snapshot: PullRequestMonitorSnapshot = {
    provider: "github",
    host: input.host,
    repository: input.repository,
    number: input.number,
    state,
    isDraft: pullRequest.isDraft,
    headSha,
    baseBranch: pullRequest.baseRefName,
    headBranch: pullRequest.headRefName,
    mergeability: mergeabilityOf(pullRequest.mergeable),
    behindBaseBy:
      typeof compareDecoded.behind_by === "number" ? Math.max(0, compareDecoded.behind_by) : null,
    titleExcerpt: excerpt(pullRequest.title, 200),
    url: pullRequest.url,
    fetchedAt,
    sourceRevision,
    completeness: {
      reviewsComplete: !pullRequest.reviews.pageInfo.hasNextPage,
      reviewThreadsComplete: !pullRequest.reviewThreads.pageInfo.hasNextPage,
      issueCommentsComplete: issueCommentsDecoded.length < 100,
      checksComplete: checkRunsDecoded.check_runs.length < 100,
      // GitHub check-runs endpoint is observed checks, not branch protection required set.
      requiredChecksKnown: false,
    },
    reviews,
    reviewThreads,
    issueComments,
    checkRuns,
  };

  return snapshot;
});
