# Worktree cleanup reconciliation

Worktree cleanup is a durable reconciliation process, not permission to delete idle-looking directories.

## Diagnostic entry points

Distinguish a registered checkout from an already-detached `.t3-worktree-trash` entry before
tracing a failure:

- [ThreadDeletionReactor](../apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts)
  owns cleanup eligibility, durable jobs, reservations, and checkout detachment.
- [StorageCleanup](../apps/server/src/storage/StorageCleanup.ts) orchestrates storage plans
  and per-item outcomes. Its [worktree contributor](../apps/server/src/storage/contributors/worktrees.ts)
  calls the reactor's `reclaimWorktreeNow` for checkouts, but removes detached trash directly.
- [WorktreeCleanupJobs](../apps/server/src/persistence/Layers/WorktreeCleanupJobs.ts)
  persists status, reason, attempt count, and next retry time. A failed trash removal and a
  deferred checkout reclamation therefore require different evidence.

## Automatic cleanup policy

The server may remove a worktree only when all of the following are true:

- The thread is archived, the deleted-thread event included explicit cleanup consent, or the thread meets the configured idle-reclamation policy's activity and runtime checks. PR state is not an archive-cleanup gate.
- The path is outside the project workspace root and still resolves to the same canonical path recorded by the intent.
- Git reports the path as a registered worktree of the expected repository and branch.
- No other active thread owns the canonical path, including aliases, and the target still meets its source-specific eligibility checks.
- The checkout is clean, including untracked files and submodule changes.

Branches are preserved and dirty checkouts are never force-removed. Dirty, unregistered, root, repository/branch-mismatch, and ambiguous historical candidates remain blocked or visible for manual review. Eligible checkouts are detached under the checkout lock by rename and Git pruning; their bytes are removed outside the lock. Unarchive or the next message restores a reclaimed checkout from its retained branch.

A failed cleanliness inspection is a cleanup failure, not a dirty result: preserve the Git error for retry and diagnosis rather than silently waiting for edits to disappear.

## Durable states and recovery

Cleanup intent is stored separately from the canonical-path removal reservation. Waiting or review-only work therefore does not block a new workspace assignment; only a path reserved for an in-progress removal does.

The cleanup worker obtains that removal reservation before stopping the target provider session or deleting terminal history. While the reservation is held, unarchive and turn-start commands for the checkout are rejected under the orchestration worktree lock; if those commands win the race first, the worker observes the cancelled/ineligible intent and performs no teardown. Slow provider, terminal, and Git I/O runs after the lock is released.

Migration 085 converts legacy rows to `needs-attention` unless they were explicitly cancelled. Startup recovery inspects `removing` rows against the real Git registration and filesystem state: a checkout already absent after successful detachment is completed, while an unresolved reservation is returned to retryable waiting state or surfaced for review. Repeated discovery preserves attempt counts, backoff, and explicit cancellation.

The registered-worktree inventory is bounded to known, non-deleted project repositories. It reports owners, cleanup status, reason, and next retry time. Retry and keep actions are explicit; they do not perform cleanup directly.

Workspace handoff does not create a cleanup job. The released checkout remains in Git's registered-worktree inventory for manual review, even when no thread points to it. Moving a chat is not permission to remove its previous checkout.

Inventory entries group every persisted cleanup intent by its recorded canonical path, including multiple intents for a shared path and intents whose checkout is no longer registered. Historical legacy rows cannot be retried automatically; a new archive or delete lifecycle may create a fresh source-aware intent without resetting discovery backoff or an in-progress removal.
