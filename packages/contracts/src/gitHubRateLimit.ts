/**
 * GitHub API rate-limit handling shared by the server and the web client.
 *
 * When the hourly quota is exhausted every `gh` call fails the same way, and
 * without special handling each failure looks like an ordinary error: nothing
 * is cached, TanStack retries it, and polling keeps paying for `gh`
 * subprocesses that cannot succeed. These helpers give that one failure a
 * stable, matchable sentence so every layer can treat it as "wait, don't
 * retry" instead of as a fresh error.
 */

/** The stable first sentence every rate-limit detail starts with. */
export const GITHUB_RATE_LIMIT_MARKER = "GitHub API rate limit exceeded";

/**
 * True for the ways `gh` reports an exhausted quota: the primary "API rate
 * limit exceeded" refusal, secondary rate limits, and 403 rate_limit bodies.
 * The already-friendly message matches too, so detection works before and
 * after the rewrite and at any depth of a `cause` chain.
 */
export function isGitHubRateLimitMessage(text: string): boolean {
  if (text.includes(GITHUB_RATE_LIMIT_MARKER)) return true;
  const lower = text.toLowerCase();
  if (lower.includes("secondary rate limit")) return true;
  if (lower.includes("api rate limit")) return true;
  if (lower.includes("rate limit") && lower.includes("exceed")) return true;
  if (lower.includes("rate_limit") && lower.includes("403")) return true;
  return false;
}

/**
 * The detail the UI shows for a rate-limit failure: what happened, that reads
 * pause on their own, and that the quota resets within the hour so repeated
 * retries buy nothing. Deliberately free of reset-minute precision — `gh`
 * does not report the reset instant in the failure itself.
 */
export function formatGitHubRateLimitDetail(): string {
  return (
    `${GITHUB_RATE_LIMIT_MARKER}. ` +
    "Pull-request reads are paused briefly and resume on their own — " +
    "no need to keep retrying. The quota usually resets within the hour."
  );
}

/**
 * Swap a raw `gh` rate-limit failure for the friendly detail; anything else
 * comes back unchanged so ordinary errors keep their wording.
 */
export function rewriteGitHubRateLimitDetail(detail: string): string {
  return isGitHubRateLimitMessage(detail) ? formatGitHubRateLimitDetail() : detail;
}
