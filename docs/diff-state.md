# Diff Panel

T3 Code's diff panel is currently backed by two active diff sources:

- **Review preview diffs** for branch and working-tree review. These come from `ReviewService.getDiffPreview`, which delegates to the active VCS driver and returns `ReviewDiffPreviewSource` entries.
- **Checkpoint diffs** for completed turns. These still come from orchestration checkpoint diff RPCs through `useCheckpointDiff`.

The older checkpoint-only `DiffState` server module has been removed. Its useful guarantees now belong in the active review-preview path instead of a separate parallel model.

## Review preview source model

Each `ReviewDiffPreviewSource` includes:

- `status` — `ready` when the source was computed, `error` when that source failed.
- `error` — a source-level message when `status` is `error`.
- `diff`, `diffHash`, and `truncated` — the raw patch payload and cache/freshness metadata.
- `files` and `metadata` — server-computed file counts, line counts, and safety classification.

Source-level errors are partial: a working-tree diff failure does not prevent the branch-range source from returning, and a branch-range failure does not erase the working-tree source.

## File safety

The server classifies review-preview files as:

- `normal`
- `large`
- `unrenderable`

Binary patches, oversized sections, very long lines, excessive deletion-heavy diffs, and hidden bidi control characters are detected before the UI renders the source. The UI can use this metadata to warn, collapse, or skip unsafe files.

## Freshness

Review preview queries currently use a short stale window. They are not yet driven by a dedicated diff event stream. If the panel needs Warp-like live freshness during rapid workspace changes, the next step is to refresh active review-preview queries from VCS status updates for the selected cwd/base ref.
