import { describe, expect, it } from "vitest";
import { GITHUB_RATE_LIMIT_MARKER } from "@t3tools/contracts";

import { isRateLimitQueryError, retryUnlessRateLimited } from "./rateLimitQuery";

describe("rateLimitQuery", () => {
  it("detects the server's rate-limit marker in an RPC error message", () => {
    expect(
      isRateLimitQueryError(
        new Error(
          `Pull request operation detail failed: ${GITHUB_RATE_LIMIT_MARKER}. Reads are paused.`,
        ),
      ),
    ).toBe(true);
  });

  it("follows an Error cause chain", () => {
    expect(
      isRateLimitQueryError(
        new Error("request failed", { cause: new Error(GITHUB_RATE_LIMIT_MARKER) }),
      ),
    ).toBe(true);
  });

  it("ignores ordinary failures and non-errors", () => {
    expect(isRateLimitQueryError(new Error("Not Found (HTTP 404)"))).toBe(false);
    expect(isRateLimitQueryError(null)).toBe(false);
    expect(isRateLimitQueryError("rate limit")).toBe(false);
  });

  it("never retries a rate-limit refusal but keeps three attempts otherwise", () => {
    const limited = new Error(GITHUB_RATE_LIMIT_MARKER);
    const ordinary = new Error("boom");
    expect(retryUnlessRateLimited(0, limited)).toBe(false);
    expect(retryUnlessRateLimited(0, ordinary)).toBe(true);
    expect(retryUnlessRateLimited(2, ordinary)).toBe(true);
    expect(retryUnlessRateLimited(3, ordinary)).toBe(false);
  });
});
