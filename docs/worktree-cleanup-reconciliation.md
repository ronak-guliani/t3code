# Worktree cleanup reconciliation

Worktree cleanup is a durable reconciliation process, not idle-directory garbage collection.

## Automatic cleanup policy

The server may remove a worktree only when all of the following are true:

- The thread is archived and its pull request has been freshly verified as merged, or the deleted-thread event included explicit cleanup consent.
- The path is outside the project workspace root and still resolves to the same canonical path recorded by the intent.
- Git reports the path as a registered worktree of the expected repository.
- No active thread owns the canonical path, including aliases.
- The checkout is clean, including untracked files and submodule changes.

Branches are never deleted and Git removal is never forced. Dirty, unregistered, root, no-PR, closed-unmerged, unknown, repository-mismatch, and ambiguous historical candidates remain visible for manual review.

## Durable states and recovery

Cleanup intent is stored separately from the canonical-path removal reservation. Waiting or review-only work therefore does not block a new workspace assignment; only a path reserved for an in-progress removal does.

Migration 085 converts legacy rows to `needs-attention` unless they were explicitly cancelled. Startup recovery inspects `removing` rows against the real Git registration and filesystem state: a path already absent after a successful Git removal is completed, while an unresolved reservation is returned to retryable waiting state or surfaced for review. Repeated discovery preserves attempt counts, backoff, and explicit cancellation.

The registered-worktree inventory is bounded to known, non-deleted project repositories. It reports owners, cleanup status, reason, and next retry time. Retry and keep actions are explicit; they do not perform cleanup directly.

Inventory entries group every persisted cleanup intent by its recorded canonical path, including multiple intents for a shared path and intents whose checkout is no longer registered. Historical legacy rows cannot be retried automatically; a new archive or delete lifecycle may create a fresh source-aware intent without resetting discovery backoff or an in-progress removal.
