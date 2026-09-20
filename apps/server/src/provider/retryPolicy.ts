import { Effect } from "effect";

export interface ExponentialBackoffSpec {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly factor?: number;
}

export interface RetryBackoff {
  /** Current delay, then advance the schedule (capped at maxMs). */
  readonly nextDelayMs: () => number;
  /** Return the schedule to its initial delay (call on success). */
  readonly reset: () => void;
}

/**
 * Single owner of provider reconnect/recovery cadence. The OpenCode adapter
 * previously spread four hand-rolled `Math.min(delay * 2, cap)` loops across
 * turn reconciliation, prompt admission, and event-stream (re)subscribe; a
 * schedule fix in one loop missed the others. Loops keep their own shape and
 * exit conditions — only the delay math lives here, behind one narrow
 * interface with named presets per recovery kind.
 */
export function makeRetryBackoff(spec: ExponentialBackoffSpec): RetryBackoff {
  const factor = spec.factor ?? 2;
  let currentMs = spec.initialMs;
  return {
    nextDelayMs: () => {
      const delayMs = currentMs;
      currentMs = Math.min(currentMs * factor, spec.maxMs);
      return delayMs;
    },
    reset: () => {
      currentMs = spec.initialMs;
    },
  };
}

/** Turn reconciliation polling: starts patient, backs off while a long turn stays busy. */
export const OPENCODE_RECONCILE_BACKOFF: ExponentialBackoffSpec = {
  initialMs: 250,
  maxMs: 5_000,
};

/** Event-stream (re)subscribe: reconnects fast, then backs off to avoid hot-spinning. */
export const OPENCODE_SUBSCRIBE_BACKOFF: ExponentialBackoffSpec = {
  initialMs: 100,
  maxMs: 2_000,
};

export const OPENCODE_INITIAL_SUBSCRIBE_ATTEMPTS = 5;
export const OPENCODE_ADMISSION_ATTEMPTS = 5;
export const OPENCODE_ADMISSION_DELAY_MS = 100;

/**
 * Wall-clock sleep preserved exactly as the adapter's local helper: a raw
 * timer rather than `Effect.sleep`, so Effect TestClock semantics in existing
 * adapter tests are unchanged.
 */
export const sleepMs = (milliseconds: number): Effect.Effect<void> =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
  );
