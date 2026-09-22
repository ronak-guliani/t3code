import type { GitPullRequestAssociation, ThreadPullRequestLink } from "@t3tools/contracts";

const PULL_REQUEST_PATH_MARKERS = [
  "pull",
  "pulls",
  "pullrequest",
  "merge_requests",
  "pull-requests",
] as const;

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
      PULL_REQUEST_PATH_MARKERS.includes(
        part.toLowerCase() as (typeof PULL_REQUEST_PATH_MARKERS)[number],
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

export function seedLegacyThreadPullRequestLink(
  links: ReadonlyArray<ThreadPullRequestLink> | undefined,
  pullRequest: GitPullRequestAssociation | null | undefined,
  linkedAt: string,
): ReadonlyArray<ThreadPullRequestLink> {
  const existingLinks = links ?? [];
  if (
    pullRequest === null ||
    pullRequest === undefined ||
    existingLinks.some((link) => sameThreadPullRequest(link.pullRequest, pullRequest))
  ) {
    return existingLinks;
  }
  return [
    {
      pullRequest,
      source: "recovered",
      linkedAt,
    },
    ...existingLinks,
  ];
}

function pullRequestsForSearch(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly pullRequest?: GitPullRequestAssociation | null | undefined;
}): GitPullRequestAssociation[] {
  const linked = (thread.pullRequests ?? []).map((link) => link.pullRequest);
  const legacy = thread.pullRequest;
  if (
    legacy === null ||
    legacy === undefined ||
    linked.some((pullRequest) => sameThreadPullRequest(pullRequest, legacy))
  ) {
    return linked;
  }
  return [...linked, legacy];
}

export function normalizeThreadPullRequestSearchQuery(query: string): string | null {
  try {
    const url = new URL(query.trim());
    const parts = url.pathname.split("/").filter(Boolean);
    const markerIndex = parts.findLastIndex((part) =>
      PULL_REQUEST_PATH_MARKERS.includes(
        part.toLowerCase() as (typeof PULL_REQUEST_PATH_MARKERS)[number],
      ),
    );
    const number = Number(parts[markerIndex + 1]);
    if (markerIndex <= 0 || !Number.isSafeInteger(number) || number <= 0) return null;
    return `${url.host.toLowerCase()}/${parts.slice(0, markerIndex).join("/").toLowerCase()}#${number}`;
  } catch {
    return null;
  }
}

/** Search terms for linked PRs, including the legacy single-PR projection. */
export function threadPullRequestSearchTerms(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly pullRequest?: GitPullRequestAssociation | null | undefined;
}): string[] {
  return pullRequestsForSearch(thread).flatMap((pullRequest) => {
    const identity = threadPullRequestIdentity(pullRequest);
    return [
      `#${pullRequest.number}`,
      `${identity.repository}#${pullRequest.number}`,
      `${identity.host}/${identity.repository}#${pullRequest.number}`,
      pullRequest.url,
      pullRequest.title,
    ];
  });
}
