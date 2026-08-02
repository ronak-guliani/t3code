import { expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Latch } from "effect";
import { TestClock } from "effect/testing";

import { GitCommandError, type GitResolveReviewChangesContextResult } from "@t3tools/contracts";

import {
  REVIEW_CONTEXT_PREWARM_MAX_ENTRIES,
  REVIEW_CONTEXT_PREWARM_TTL_MS,
  makeReviewContextPrewarmCache,
  reviewContextPrewarmKey,
} from "./ReviewContextPrewarmCache.ts";

const result = (branch: string) => ({ branch }) as unknown as GitResolveReviewChangesContextResult;

const failure = new GitCommandError({
  operation: "test",
  command: "git diff",
  cwd: "/repo",
  detail: "boom",
});

it("does not cache scopes whose diff can change between hover and click", () => {
  expect(reviewContextPrewarmKey({ cwd: "/repo", scope: "uncommitted" })).toBeNull();
  expect(reviewContextPrewarmKey({ cwd: "/repo", scope: "against-base" })).toBeNull();
  expect(
    reviewContextPrewarmKey({ cwd: "/repo", scope: "pull-request", pullRequestNumber: undefined }),
  ).toBeNull();
});

it("keys pull requests by repository and number", () => {
  const key = reviewContextPrewarmKey({
    cwd: "/repo",
    scope: "pull-request",
    pullRequestNumber: 7,
  });
  expect(key).not.toBeNull();
  expect(key).not.toBe(
    reviewContextPrewarmKey({ cwd: "/repo", scope: "pull-request", pullRequestNumber: 8 }),
  );
  expect(key).not.toBe(
    reviewContextPrewarmKey({ cwd: "/other", scope: "pull-request", pullRequestNumber: 7 }),
  );
});

it.effect("always recaptures when there is no key", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    let calls = 0;
    const compute = Effect.sync(() => {
      calls += 1;
      return result("a");
    });

    yield* cache.resolve(null, compute);
    yield* cache.resolve(null, compute);

    expect(calls).toBe(2);
  }),
);

it.effect("reuses a captured pull request within the TTL", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    let calls = 0;
    const compute = Effect.sync(() => {
      calls += 1;
      return result("a");
    });

    const first = yield* cache.resolve("pr", compute);
    const second = yield* cache.resolve("pr", compute);

    expect(calls).toBe(1);
    expect(second).toBe(first);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("recaptures once the TTL has elapsed", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    let calls = 0;
    const compute = Effect.sync(() => {
      calls += 1;
      return result(`a${calls}`);
    });

    yield* cache.resolve("pr", compute);
    yield* TestClock.adjust(Duration.millis(REVIEW_CONTEXT_PREWARM_TTL_MS));
    const second = yield* cache.resolve("pr", compute);

    expect(calls).toBe(2);
    expect(second).toStrictEqual(result("a2"));
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a click joins a prewarm that is still running", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    const release = yield* Latch.make(false);
    let calls = 0;
    const compute = Effect.gen(function* () {
      calls += 1;
      yield* Latch.await(release);
      return result("a");
    });

    const prewarm = yield* Effect.forkChild(cache.resolve("pr", compute));
    // Let the prewarm claim the entry before the click arrives.
    yield* Effect.yieldNow;
    const click = yield* Effect.forkChild(cache.resolve("pr", compute));

    yield* Latch.open(release);
    const prewarmed = yield* Fiber.join(prewarm);
    const clicked = yield* Fiber.join(click);

    expect(calls).toBe(1);
    expect(clicked).toBe(prewarmed);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("does not cache a failed capture", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    let calls = 0;
    const compute = Effect.suspend(() => {
      calls += 1;
      return calls === 1 ? Effect.fail(failure) : Effect.succeed(result("a"));
    });

    const first = yield* cache.resolve("pr", compute).pipe(Effect.exit);
    expect(Exit.isFailure(first)).toBe(true);

    const second = yield* cache.resolve("pr", compute);
    expect(calls).toBe(2);
    expect(second).toStrictEqual(result("a"));
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("an interrupted prewarm does not interrupt or stall the click", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    const started = yield* Latch.make(false);
    let calls = 0;
    const compute = Effect.gen(function* () {
      calls += 1;
      if (calls === 1) {
        yield* Latch.open(started);
        return yield* Effect.never;
      }
      return result("a");
    });

    const prewarm = yield* Effect.forkChild(cache.resolve("pr", compute));
    yield* Latch.await(started);
    const click = yield* Effect.forkChild(cache.resolve("pr", compute));
    // The click must already be waiting on the prewarm's entry, so that
    // interrupting the prewarm exercises the joiner's recovery path.
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(prewarm);

    expect(yield* Fiber.join(click)).toStrictEqual(result("a"));
    expect(calls).toBe(2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("bounds how many captured patches are retained", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    let calls = 0;
    const compute = Effect.sync(() => {
      calls += 1;
      return result(`a${calls}`);
    });

    for (let index = 0; index <= REVIEW_CONTEXT_PREWARM_MAX_ENTRIES; index += 1) {
      yield* cache.resolve(`pr-${index}`, compute);
    }
    const captured = calls;

    // The oldest entry was evicted to stay within the bound; the newest is warm.
    yield* cache.resolve("pr-0", compute);
    expect(calls).toBe(captured + 1);
    yield* cache.resolve(`pr-${REVIEW_CONTEXT_PREWARM_MAX_ENTRIES}`, compute);
    expect(calls).toBe(captured + 1);
  }).pipe(Effect.provide(TestClock.layer())),
);
