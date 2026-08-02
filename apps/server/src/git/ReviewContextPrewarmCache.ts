/**
 * ReviewContextPrewarmCache - lets a hover absorb the cost of a pull-request
 * review capture so the click that follows does not pay for it again.
 *
 * `gh pr view` + `gh pr diff` cost roughly 700ms of network, and they complete
 * before the review thread can be created, so the whole capture sits on the
 * critical path between clicking a pull request and seeing its thread.
 *
 * Only the pull-request scope is ever cached. A working-tree capture must not
 * be: an editor save or a background agent can change the tree between hover
 * and click, and there is no validator cheaper than the diff itself, so serving
 * a stale working-tree diff would review code the user never wrote. A pull
 * request's patch is remote and point-in-time by definition, so reusing it for
 * a few seconds is the same snapshot the click would have taken anyway.
 *
 * @module ReviewContextPrewarmCache
 */
import { Deferred, Effect, Exit } from "effect";

import type { GitCommandError, GitResolveReviewChangesContextResult } from "@t3tools/contracts";

/**
 * How long a captured pull-request patch may be reused. Long enough to cover
 * reading a menu entry before clicking it, short enough that a pull request
 * updated while the menu sits open is re-fetched.
 */
export const REVIEW_CONTEXT_PREWARM_TTL_MS = 15_000;

/** Bounds the memory held by captured patches, which are up to 4MB each. */
export const REVIEW_CONTEXT_PREWARM_MAX_ENTRIES = 4;

type ReviewContextResult = GitResolveReviewChangesContextResult;

export interface ReviewContextPrewarmCacheShape {
  /**
   * Runs `compute` under `key`, reusing or joining an entry captured within the
   * TTL. A `null` key is never cached.
   */
  readonly resolve: (
    key: string | null,
    compute: Effect.Effect<ReviewContextResult, GitCommandError>,
  ) => Effect.Effect<ReviewContextResult, GitCommandError>;
}

interface CacheEntry {
  readonly startedAt: number;
  readonly deferred: Deferred.Deferred<ReviewContextResult, GitCommandError>;
}

/**
 * Builds the cache key for an input, or `null` when the input must always be
 * captured fresh.
 */
export function reviewContextPrewarmKey(input: {
  readonly cwd: string;
  readonly scope: string;
  readonly pullRequestNumber?: number | undefined;
}): string | null {
  if (input.scope !== "pull-request" || input.pullRequestNumber === undefined) {
    return null;
  }
  return `${input.cwd}\u0000${input.pullRequestNumber}`;
}

export function makeReviewContextPrewarmCache(): ReviewContextPrewarmCacheShape {
  const entries = new Map<string, CacheEntry>();

  const evict = (key: string, entry: CacheEntry) => {
    if (entries.get(key) === entry) {
      entries.delete(key);
    }
  };

  const resolve: ReviewContextPrewarmCacheShape["resolve"] = (key, compute) =>
    Effect.gen(function* () {
      if (key === null) {
        return yield* compute;
      }

      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const existing = entries.get(key);
      if (existing) {
        if (now - existing.startedAt < REVIEW_CONTEXT_PREWARM_TTL_MS) {
          // Joins a capture that is still running, which is the common case:
          // the click usually lands before the hover's `gh` calls return.
          const exit = yield* Deferred.await(existing.deferred).pipe(Effect.exit);
          if (Exit.isSuccess(exit)) {
            return exit.value;
          }
          // The owner failed or was interrupted (its caller disconnected).
          // Interruption belongs to that fiber, not this one, so capture fresh
          // rather than propagating someone else's cancellation.
          evict(key, existing);
        } else {
          evict(key, existing);
        }
      }

      const deferred = yield* Deferred.make<ReviewContextResult, GitCommandError>();
      const entry: CacheEntry = { startedAt: now, deferred };
      entries.set(key, entry);
      if (entries.size > REVIEW_CONTEXT_PREWARM_MAX_ENTRIES) {
        const oldest = [...entries.entries()]
          .filter(([entryKey]) => entryKey !== key)
          .toSorted(([, left], [, right]) => left.startedAt - right.startedAt)[0];
        if (oldest) {
          evict(oldest[0], oldest[1]);
        }
      }

      return yield* compute.pipe(
        // Always settles the deferred, so a joiner can never wait on a capture
        // that failed or was interrupted.
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (!Exit.isSuccess(exit)) {
              evict(key, entry);
            }
          }).pipe(Effect.andThen(Deferred.done(deferred, exit))),
        ),
      );
    });

  return { resolve };
}
