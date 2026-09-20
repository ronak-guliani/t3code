import { describe, expect, it } from "vitest";

import {
  makeRetryBackoff,
  OPENCODE_ADMISSION_ATTEMPTS,
  OPENCODE_ADMISSION_DELAY_MS,
  OPENCODE_INITIAL_SUBSCRIBE_ATTEMPTS,
  OPENCODE_RECONCILE_BACKOFF,
  OPENCODE_SUBSCRIBE_BACKOFF,
} from "./retryPolicy.ts";

describe("makeRetryBackoff", () => {
  it("starts at the initial delay and doubles to the cap", () => {
    const backoff = makeRetryBackoff({ initialMs: 100, maxMs: 250 });
    expect([backoff.nextDelayMs(), backoff.nextDelayMs(), backoff.nextDelayMs()]).toEqual([
      100, 200, 250,
    ]);
    expect(backoff.nextDelayMs()).toBe(250);
  });

  it("resets to the initial delay on success", () => {
    const backoff = makeRetryBackoff({ initialMs: 100, maxMs: 2_000 });
    backoff.nextDelayMs();
    backoff.nextDelayMs();
    backoff.reset();
    expect(backoff.nextDelayMs()).toBe(100);
  });

  it("preserves the legacy OpenCode recovery schedules", () => {
    expect(OPENCODE_RECONCILE_BACKOFF).toEqual({ initialMs: 250, maxMs: 5_000 });
    expect(OPENCODE_SUBSCRIBE_BACKOFF).toEqual({ initialMs: 100, maxMs: 2_000 });
    expect(OPENCODE_INITIAL_SUBSCRIBE_ATTEMPTS).toBe(5);
    expect(OPENCODE_ADMISSION_ATTEMPTS).toBe(5);
    expect(OPENCODE_ADMISSION_DELAY_MS).toBe(100);
  });
});
