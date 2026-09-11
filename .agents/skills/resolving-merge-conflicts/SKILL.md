---
name: resolving-merge-conflicts
description: Resolves Git conflicts while preserving both sides' intent. Use for an in-progress merge or rebase, or when an authorized PR-maintenance task reports merge conflicts.
---

For authorized PR maintenance, merge the PR's base branch into the PR branch, resolve known conflicts, validate, commit, and push normally without asking again. This updates the PR branch; it does not authorize merging the PR into its target branch. PR merges, force-pushes, and history rewrites still require explicit approval. Respect narrower instructions such as inspection-only or no-push.

1. Inspect the current merge or rebase state with `git status`, `git diff --name-only --diff-filter=U`, and the recent history. Record unrelated staged, unstaged, and untracked work before editing.

2. Find the primary source and intent for each conflict. Read the relevant commit messages, issues, or pull requests. If the intended result is unclear or the conflict is unrelated to the user's request, stop and ask instead of guessing.

3. Resolve only conflicts whose intent is known. Preserve unrelated work. Do not automatically resolve every conflict, and do not automatically run `git merge --abort` or `git rebase --abort`. Aborting is a user-directed choice because it can discard the operation's in-progress state.

4. After each resolution, inspect the file and run the smallest relevant checks. Stage only resolved conflict paths and any task-owned files needed for the operation:

   ```sh
   git add -- <resolved-conflict-paths>
   git status --short
   ```

   Never use `git add -A` or `git add .` when unrelated work is present.

5. Continue the merge or rebase only after `git diff --check` passes and `git diff --name-only --diff-filter=U` is empty. Finish with the repository's normal commit or rebase continuation only when the user asked for that operation. If a conflict remains ambiguous, leave it unresolved and report the exact path and question.
