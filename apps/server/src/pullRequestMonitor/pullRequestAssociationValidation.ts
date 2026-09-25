import type {
  GitResolvedPullRequest,
  GitStatusLocalResult,
  OrchestrationProject,
  OrchestrationThread,
} from "@t3tools/contracts";
import { GitHubCliError } from "@t3tools/contracts";
import { Schema } from "effect";

const ASSOCIATION_RETRY_FALLBACK_MS = 60_000;
const isGitHubCliError = Schema.is(GitHubCliError);

export type PullRequestAssociationBlockReason =
  | "repository-mismatch"
  | "head-mismatch"
  | "workspace-changed";

export function pullRequestAssociationRetryAt(error: unknown, nowMs = Date.now()): string | null {
  if (!isGitHubCliError(error)) return null;
  const rateLimited =
    error.retryAfterAt !== undefined ||
    /rate[\s-]?limit|secondary rate|http 429/iu.test(error.detail);
  if (!rateLimited) return null;
  return error.retryAfterAt ?? new Date(nowMs + ASSOCIATION_RETRY_FALLBACK_MS).toISOString();
}

function repositoryKeyFromPullRequestUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/u.exec(parsed.pathname);
    if (parsed.protocol !== "https:" || !parsed.hostname || !match) return null;
    return `${parsed.hostname}/${match[1]}/${match[2]}`.toLowerCase();
  } catch {
    return null;
  }
}

export function pullRequestAssociationBlockReason(input: {
  readonly thread: Pick<OrchestrationThread, "projectId" | "branch">;
  readonly project: Pick<OrchestrationProject, "id" | "repositoryIdentity"> | undefined;
  readonly localStatus: GitStatusLocalResult;
  readonly pullRequest: GitResolvedPullRequest;
}): PullRequestAssociationBlockReason | null {
  const repositoryKey = repositoryKeyFromPullRequestUrl(input.pullRequest.url);
  if (
    !repositoryKey ||
    !input.project ||
    input.project.id !== input.thread.projectId ||
    input.project.repositoryIdentity?.canonicalKey.toLowerCase() !== repositoryKey
  ) {
    return "repository-mismatch";
  }

  if (
    !input.localStatus.isRepo ||
    !input.localStatus.hasOriginRemote ||
    input.localStatus.isDefaultBranch ||
    input.thread.branch === null ||
    input.localStatus.branch !== input.thread.branch
  ) {
    return "workspace-changed";
  }

  return input.pullRequest.headBranch === input.thread.branch ? null : "head-mismatch";
}
