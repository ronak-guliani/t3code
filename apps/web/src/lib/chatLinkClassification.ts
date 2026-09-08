import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { buildThreadPath } from "@t3tools/shared/threadUrl";

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

export function buildGitHubIssueReferenceUrl(reference: GitHubShorthandReference): string {
  return `https://github.com/${reference.repository}/issues/${reference.number}`;
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase();
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

  const normalizedEnvironmentId = EnvironmentId.make(environmentId);
  if (trustedEnvironmentIds && !trustedEnvironmentIds.has(normalizedEnvironmentId)) {
    return null;
  }

  return {
    environmentId: normalizedEnvironmentId,
    threadId: ThreadId.make(threadId.toLowerCase()),
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

  const trustedOrigins = new Map(
    input.trustedOrigins.flatMap((entry) => {
      const origin = normalizeOrigin(entry.origin);
      return origin ? [[origin, entry.environmentId] as const] : [];
    }),
  );
  const origin = url.origin.toLowerCase();
  if (!trustedOrigins.has(origin)) return null;
  if (url.search || url.hash) return null;

  const ref = parseCanonicalThreadPath(url.pathname, input.trustedEnvironmentIds);
  if (!ref) return null;

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
