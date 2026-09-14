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
    const markerIndex = parts.findIndex((part) =>
      ["pull", "pulls", "merge_requests", "pull-requests"].includes(part.toLowerCase()),
    );
    const repository = markerIndex > 0 ? parts.slice(0, markerIndex).join("/") : "";
    return {
      host: url.hostname.toLowerCase(),
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

export function legacyThreadPullRequestLink(
  existing: ThreadPullRequestLink | undefined,
  pullRequest: GitPullRequestAssociation,
  linkedAt: string,
): ThreadPullRequestLink {
  return existing ? { ...existing, pullRequest } : { pullRequest, source: "manual", linkedAt };
}

export function upsertLegacyThreadPullRequestLink(
  links: ReadonlyArray<ThreadPullRequestLink> | undefined,
  pullRequest: GitPullRequestAssociation,
  linkedAt: string,
): ReadonlyArray<ThreadPullRequestLink> {
  const existingLinks = links ?? [];
  const existingIndex = existingLinks.findIndex((link) =>
    sameThreadPullRequest(link.pullRequest, pullRequest),
  );
  const nextLink = legacyThreadPullRequestLink(existingLinks[existingIndex], pullRequest, linkedAt);
  return existingIndex < 0
    ? [...existingLinks, nextLink]
    : existingLinks.map((link, index) => (index === existingIndex ? nextLink : link));
}

export function visibleThreadPullRequests(
  pullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined,
): ReadonlyArray<ThreadPullRequestLink> {
  return pullRequests ?? [];
}
