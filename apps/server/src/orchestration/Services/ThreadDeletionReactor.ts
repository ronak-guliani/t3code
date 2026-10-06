/**
 * ThreadDeletionReactor - Thread deletion cleanup reactor service interface.
 *
 * Owns background workers that react to thread deletion domain events and
 * perform best-effort runtime cleanup for provider sessions, terminals, and
 * explicitly requested orphaned worktrees.
 *
 * @module ThreadDeletionReactor
 */
import type { ThreadId } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Scope } from "effect";

export type ManualWorktreeReclaimOutcome =
  | { readonly status: "removed" }
  | { readonly status: "skipped"; readonly reason: string };

/**
 * ThreadDeletionReactorShape - Service API for thread deletion cleanup.
 */
export interface ThreadDeletionReactorShape {
  /**
   * Start reacting to thread.deleted orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;

  /**
   * Reclaim a chat's worktree now ("Clean up now") through the durable cleanup
   * job and its reservation path: archive cleanup for archived chats, idle
   * reclaim with the age threshold ignored for active ones. Retry backoff and
   * the automatic-cleanup master switch are bypassed; every safety rule of the
   * automatic path still applies, and the checkout restores on the next turn.
   */
  /**
   * Whether an active (non-archived) chat's worktree passes every idle-reclaim
   * rule except age, including a clean checkout. Read-only.
   */
  readonly isIdleReclaimEligibleIgnoringAge: (threadId: ThreadId) => Effect.Effect<boolean>;

  readonly reclaimWorktreeNow: (threadId: ThreadId) => Effect.Effect<ManualWorktreeReclaimOutcome>;
}

/**
 * ThreadDeletionReactor - Service tag for thread deletion cleanup workers.
 */
export class ThreadDeletionReactor extends Context.Service<
  ThreadDeletionReactor,
  ThreadDeletionReactorShape
>()("t3/orchestration/Services/ThreadDeletionReactor") {}
