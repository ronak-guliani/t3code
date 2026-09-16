import type { GitPullRequestAssociation, ThreadPullRequestLink } from "@t3tools/contracts";

export interface ThreadPullRequestIdentity {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

export function threadPullRequestIdentity(
  pullRequest: Pick<GitPullRequestAssociation, "url" | "number">,
): ThreadPullRequestIdentity {
  try {
    const url = new URL(pullRequest.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const markerIndex = parts.findLastIndex((part) =>
      ["pull", "pulls", "pullrequest", "merge_requests", "pull-requests"].includes(
        part.toLowerCase(),
      ),
    );
    const repository = markerIndex > 0 ? parts.slice(0, markerIndex).join("/") : "";
    return {
      host: url.host.toLowerCase(),
      repository: repository.toLowerCase(),
      number: pullRequest.number,
    };
  } catch {
    return {
      host: "unknown",
      repository: pullRequest.url.trim().toLowerCase(),
      number: pullRequest.number,
    };
  }
}

export function threadPullRequestKey(
  pullRequest: Pick<GitPullRequestAssociation, "url" | "number">,
): string {
  const identity = threadPullRequestIdentity(pullRequest);
  return `${identity.host}/${identity.repository}#${identity.number}`;
}

export function sameThreadPullRequest(
  left: Pick<GitPullRequestAssociation, "url" | "number">,
  right: Pick<GitPullRequestAssociation, "url" | "number">,
): boolean {
  return threadPullRequestKey(left) === threadPullRequestKey(right);
}

export function sameThreadPullRequestAssociation(
  left: GitPullRequestAssociation,
  right: GitPullRequestAssociation,
): boolean {
  return (
    sameThreadPullRequest(left, right) &&
    left.url === right.url &&
    left.title === right.title &&
    left.baseBranch === right.baseBranch &&
    left.headBranch === right.headBranch &&
    left.state === right.state
  );
}

export function legacyThreadPullRequestLink(
  existing: ThreadPullRequestLink | undefined,
  pullRequest: GitPullRequestAssociation,
  linkedAt: string,
  source?: ThreadPullRequestLink["source"],
): ThreadPullRequestLink {
  return existing
    ? { ...existing, pullRequest, ...(source !== undefined ? { source } : {}) }
    : { pullRequest, source: source ?? "manual", linkedAt };
}

export function upsertLegacyThreadPullRequestLink(
  links: ReadonlyArray<ThreadPullRequestLink> | undefined,
  pullRequest: GitPullRequestAssociation,
  linkedAt: string,
  source?: ThreadPullRequestLink["source"],
): ReadonlyArray<ThreadPullRequestLink> {
  const existingLinks = links ?? [];
  const existingIndex = existingLinks.findIndex((link) =>
    sameThreadPullRequest(link.pullRequest, pullRequest),
  );
  const nextLink = legacyThreadPullRequestLink(
    existingLinks[existingIndex],
    pullRequest,
    linkedAt,
    source,
  );
  return existingIndex < 0
    ? [...existingLinks, nextLink]
    : existingLinks.map((link, index) => (index === existingIndex ? nextLink : link));
}

/** Search terms for linked PRs, including the legacy single-PR projection. */
export function threadPullRequestSearchTerms(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly pullRequest?: GitPullRequestAssociation | null | undefined;
}): string[] {
  if (thread.pullRequests !== undefined && thread.pullRequests.length > 0) {
    return thread.pullRequests.flatMap(({ pullRequest }) => {
      const identity = threadPullRequestIdentity(pullRequest);
      return [
        `#${pullRequest.number}`,
        `${identity.repository}#${pullRequest.number}`,
        pullRequest.url,
        pullRequest.title,
      ];
    });
  }
  const legacy = thread.pullRequest;
  if (legacy === null || legacy === undefined) return [];
  const identity = threadPullRequestIdentity(legacy);
  return [`#${legacy.number}`, `${identity.repository}#${legacy.number}`, legacy.url, legacy.title];
}
