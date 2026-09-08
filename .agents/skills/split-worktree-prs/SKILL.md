---
name: split-worktree-prs
description: Split a large dirty git worktree into logical branches and GitHub pull requests without losing staged, unstaged, or untracked work. Use when the user asks for logical PRs or branch decomposition.
---

# Split worktree PRs

Use this procedure only after the user asks to split the current worktree. Do not run the mutation recipe against a user's work merely to validate this document.

## 1. Capture the starting state

Record the current worktree and branch:

```sh
original_branch=$(git branch --show-current)
git --no-pager status --short --branch
git --no-pager diff --stat
git --no-pager diff --cached --stat
git ls-files --others --exclude-standard
```

Inspect both `git diff` and `git diff --cached`. Untracked files are part of the work even though neither diff includes them.

Stop before mutation if HEAD is detached, a merge or rebase is in progress, submodules contain dirty work, or there are no changes to split. Record the starting HEAD and status so restoration can be compared with them. Ignored files are not included by `-u`; explicitly preserve any ignored artifacts needed for recovery.

Create a safety copy before changing branches. Preserve the exact stash object immediately; never rely on a moving `stash@{0}` name:

```sh
git stash push -u -m "copilot-pr-split-full-worktree" &&
stash_ref=$(git rev-parse refs/stash)
git show --stat --oneline "$stash_ref"
git show --stat --oneline "$stash_ref^2"
if git rev-parse --verify --quiet "$stash_ref^3" >/dev/null; then
  git show --stat --oneline "$stash_ref^3"
fi
```

The stash commit stores the worktree tree, `"$stash_ref^2"` stores the staged index tree, and `"$stash_ref^3"` stores untracked files when present. Proceed only after stash creation succeeds and the worktree/index are clean. Record the exact object ID in durable task state and reassign `stash_ref` when using a fresh shell; do not assume shell variables survive tool calls. Leave the safety stash until the user confirms it is no longer needed.

## 2. Choose coherent slices

Separate genuinely independent slices when each can target the same base branch and be reviewed or merged on its own. If one slice requires another slice's commits, call them a stacked or dependent series instead. For dependent slices, use the earlier slice branch as the later slice's base and state the order in each PR description. Do not pretend dependent work is independent just to make the PR count look cleaner.

Prefer dependency order: shared contracts and runtime first, then server/API, web/client, and app/mobile/UI. Keep docs/config with the code they explain unless they are independently useful.

## 3. Create each branch safely

Start every independent slice from the requested base branch:

```sh
git switch --detach <base>
git switch -c split/<scope>
```

If `split/<scope>` already exists, stop and inspect it. Choose a new name or explicitly reuse it after checking its history. Never use `git switch -C`, `git reset`, or a forced branch rewrite.

Apply only the selected slice's changes relative to the original HEAD. Do not restore entire tracked files from the stash onto a different base: that would overwrite base-branch or earlier-slice changes. Write a binary-capable patch to a unique task artifact path and apply it to the clean slice branch:

```sh
git diff --binary "$stash_ref^1" "$stash_ref" -- <tracked-paths> > <slice-patch>
git apply --3way --index <slice-patch>
```

Include staged additions, deletions, and both sides of renames. When slices share files, select the intended hunks rather than replaying the whole file patch in each slice. Resolve conflicts by intent, or stop and report the blocked slice; never substitute a full-file restore. The original index split stays in the safety stash for final restoration.

For an untracked file, confirm it exists in the third parent and its destination is absent from both the slice's index and filesystem before restoring it:

```sh
git cat-file -e "$stash_ref^3:<untracked-path>"
git restore --source="$stash_ref^3" --worktree -- <untracked-path>
```

Then inspect `git status`, stage only the slice, commit, push, and create the PR. Repeat from the original base for independent slices, or from the preceding slice branch for a dependent series.

## 4. Restore the original worktree

After all branches are created, confirm the last slice has no remaining changes, return to the original branch, and verify its HEAD still equals the recorded starting HEAD. If the branch moved, stop rather than apply the stash onto someone else's new work. Restore both index and worktree layers:

```sh
git switch "$original_branch"
git stash apply --index "$stash_ref"
git status --short --branch
```

If restoration reports conflicts, stop and preserve the stash. Do not reset or clean the worktree. Report the exact paths and leave the safety stash in place.

## Safety rules

- Never use `git reset --hard`, destructive checkout commands, force-push, or `git stash drop` in this workflow.
- Do not include unrelated staged, unstaged, or untracked changes in a slice.
- Preserve the original branch, current worktree, and exact stash identity.
- If branch, commit, push, or PR creation fails, preserve the stash and report the exact state.

## Final response

Report each PR URL, whether the slices are independent or stacked, whether the original worktree was restored, and the exact safety stash ref that remains.
