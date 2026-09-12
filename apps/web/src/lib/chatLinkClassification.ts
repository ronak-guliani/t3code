import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { buildThreadPath } from "@t3tools/shared/threadUrl";

import { isLoopbackHostname } from "../environments/primary/target";

const THREAD_ID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const THREAD_ID_PATTERN = new RegExp(`^${THREAD_ID_SOURCE}$`, "i");

export const THREAD_REFERENCE_PATTERN = new RegExp(
  `\\b(Thread(?:\\s+ID)?\\s*:?[ \\t]+|thread[_-]?id\\s*[:=][ \\t]*|thread[/:])(${THREAD_ID_SOURCE})\\b`,
  "gi",
);

const GITHUB_REFERENCE_PATTERN = /(?:\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d*)\b/g;

export interface TrustedThreadOrigin {
  readonly origin: string;
  readonly environmentId?: EnvironmentId;
}

export interface ExplicitThreadLink {
  readonly ref: ScopedThreadRef;
  readonly href: string;
}

export interface GitHubShorthandReference {
  readonly repository: string;
  readonly number: number;
}

export interface GitHubReference {
  readonly repository: string | null;
  readonly number: number;
}

export function buildGitHubIssueReferenceUrl(
  reference: GitHubShorthandReference & { readonly host?: string },
): string {
  const host = reference.host?.trim() ? reference.host.trim().toLowerCase() : "github.com";
  return `https://${host}/${reference.repository}/issues/${reference.number}`;
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

function decodePathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function parseCanonicalThreadPath(
  pathname: string,
  trustedEnvironmentIds?: ReadonlySet<EnvironmentId>,
): ScopedThreadRef | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;

  const environmentId = decodePathSegment(segments[0] ?? "");
  const threadId = decodePathSegment(segments[1] ?? "");
  if (!environmentId || !threadId || !THREAD_ID_PATTERN.test(threadId)) return null;

  let normalizedEnvironmentId: EnvironmentId;
  try {
    normalizedEnvironmentId = EnvironmentId.make(environmentId);
  } catch {
    return null;
  }
  if (trustedEnvironmentIds && !trustedEnvironmentIds.has(normalizedEnvironmentId)) {
    return null;
  }

  let normalizedThreadId: ThreadId;
  try {
    normalizedThreadId = ThreadId.make(threadId.toLowerCase());
  } catch {
    return null;
  }

  return {
    environmentId: normalizedEnvironmentId,
    threadId: normalizedThreadId,
  };
}

export function resolveExplicitThreadLink(
  href: string,
  input: {
    readonly baseOrigin: string;
    readonly trustedOrigins: ReadonlyArray<TrustedThreadOrigin>;
    readonly trustedEnvironmentIds?: ReadonlySet<EnvironmentId>;
  },
): ExplicitThreadLink | null {
  let url: URL;
  try {
    url = new URL(href, input.baseOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;

  const ref = parseCanonicalThreadPath(url.pathname, input.trustedEnvironmentIds);
  if (!ref) return null;

  const trustedOrigins = new Map<string, { unconstrained: boolean; ids: Set<EnvironmentId> }>();
  for (const entry of input.trustedOrigins) {
    const origin = normalizeOrigin(entry.origin);
    if (!origin) continue;
    let record = trustedOrigins.get(origin);
    if (!record) {
      record = { unconstrained: false, ids: new Set<EnvironmentId>() };
      trustedOrigins.set(origin, record);
    }
    if (!entry.environmentId) {
      record.unconstrained = true;
    } else {
      record.ids.add(entry.environmentId);
    }
  }
  const origin = url.origin.toLowerCase();
  const trustedOrigin = trustedOrigins.get(origin);
  if (trustedOrigin) {
    if (!trustedOrigin.unconstrained && !trustedOrigin.ids.has(ref.environmentId)) return null;
  } else {
    // Desktop ports can change after restart; the registered environment ID,
    // not a stale loopback address, identifies the internal destination.
    const localEnvironmentOrigin = isLoopbackHostname(url.hostname)
      ? input.trustedOrigins.some((entry) => {
          if (entry.environmentId !== ref.environmentId) return false;
          const normalizedOrigin = normalizeOrigin(entry.origin);
          if (!normalizedOrigin) return false;
          const registeredUrl = new URL(normalizedOrigin);
          return (
            registeredUrl.protocol === url.protocol && isLoopbackHostname(registeredUrl.hostname)
          );
        })
      : false;
    if (!localEnvironmentOrigin) return null;
  }

  return {
    ref,
    href: buildThreadPath(ref),
  };
}

export function parseGitHubShorthandReferences(text: string): Array<GitHubShorthandReference> {
  return parseGitHubReferences(text).flatMap((reference) =>
    reference.repository ? [{ repository: reference.repository, number: reference.number }] : [],
  );
}

export function parseGitHubReferences(text: string): Array<GitHubReference> {
  return [...text.matchAll(GITHUB_REFERENCE_PATTERN)].flatMap((match) => {
    const repository = match[1];
    const rawNumber = match[2];
    const number = rawNumber ? Number(rawNumber) : NaN;
    return Number.isSafeInteger(number) && number > 0
      ? [{ repository: repository?.toLowerCase() ?? null, number }]
      : [];
  });
}

export function isThreadId(value: string): boolean {
  return THREAD_ID_PATTERN.test(value);
}
