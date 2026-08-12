import type { PullRequestMonitorReadiness } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

/** Adaptive polling cadence. Ready PRs stay monitored slowly; active blockers poll faster. */
export const POLL_BASE_MS = 45_000;
export const POLL_READY_MS = 5 * 60_000;
export const POLL_ACTIVE_MS = 20_000;
export const POLL_ERROR_BASE_MS = 30_000;
export const POLL_ERROR_MAX_MS = 10 * 60_000;
export const HOST_COOLDOWN_MS = 2 * 60_000;
export const LEASE_TTL_MS = 90_000;
export const POLL_CONCURRENCY = 4;
export const MAX_RETAINED_SNAPSHOTS = 20;

export function jitterMs(baseMs: number, unitSample: number, ratio = 0.2): number {
  const spread = Math.floor(baseMs * ratio);
  if (spread <= 0) return baseMs;
  const unit = Math.min(1, Math.max(0, unitSample));
  return baseMs + Math.floor(unit * (spread * 2 + 1)) - spread;
}

export const nextPollDelayMs = (input: {
  readonly readiness: PullRequestMonitorReadiness | null;
  readonly failureCount: number;
  readonly hadActionableEvents: boolean;
}): Effect.Effect<number> =>
  Effect.gen(function* () {
    const unit = yield* Random.next;
    if (input.failureCount > 0) {
      const exp = Math.min(
        POLL_ERROR_MAX_MS,
        POLL_ERROR_BASE_MS * 2 ** Math.min(input.failureCount, 6),
      );
      return jitterMs(exp, unit);
    }
    if (input.readiness?.ready) {
      return jitterMs(POLL_READY_MS, unit);
    }
    if (input.hadActionableEvents || (input.readiness?.blockers.length ?? 0) > 0) {
      return jitterMs(POLL_ACTIVE_MS, unit);
    }
    return jitterMs(POLL_BASE_MS, unit);
  });
