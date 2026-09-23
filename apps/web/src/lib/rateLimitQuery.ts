import { GITHUB_RATE_LIMIT_MARKER } from "@t3tools/contracts";

/**
 * True when a query failed on GitHub's exhausted quota rather than on the
 * request itself. The server rewrites every `gh` rate-limit refusal to the
 * stable marker sentence, which survives RPC inside the error message (and a
 * `cause` chain when one is attached).
 */
export function isRateLimitQueryError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.message.includes(GITHUB_RATE_LIMIT_MARKER)) return true;
    if (typeof error.cause === "string") return error.cause.includes(GITHUB_RATE_LIMIT_MARKER);
    if (error.cause instanceof Error) return isRateLimitQueryError(error.cause);
  }
  return false;
}

/**
 * TanStack `retry` that keeps the default three attempts for everything
 * except rate-limit refusals: retrying those immediately cannot succeed until
 * GitHub resets the quota, so fail fast and let the error message say when
 * to come back.
 */
export function retryUnlessRateLimited(failureCount: number, error: unknown): boolean {
  if (isRateLimitQueryError(error)) return false;
  return failureCount < 3;
}
