---
name: create-pr
description: Creates a ready-for-review GitHub pull request, or prepares PR text without publishing. Use when the user asks to create a PR, draft a PR description, or prepare current branch changes for review; description-only and readiness requests do not authorize publication.
---

# Create PR

Create a reviewable PR that accurately describes the branch's changes. Use `gh` for GitHub operations.

## Delivery mode

Apply [skill-delivery.md](../../references/skill-delivery.md) before mutations. For description-only or readiness requests, perform only read-only inspection and return the requested text or readiness findings; stop before workflow step 5. Do not stage, commit, push, create/update a PR, or associate a thread in this mode.

For publication requests, create a **ready-for-review, non-draft PR** by default. "Draft a description" is not "create a draft PR"; use draft status only when the user explicitly requests a draft PR.

## Workflow

1. Inspect the repository and determine the base branch. Prefer the branch's configured upstream PR base, then the repository default branch. Do not assume `main`.

   ```sh
   git status --short
   git branch --show-current
   git remote -v
   gh repo view --json defaultBranchRef --jq .defaultBranchRef.name
   git log --oneline <base>..HEAD
   git diff --stat <base>...HEAD
   git diff --check <base>...HEAD
   ```

2. Read the relevant diff and tests to establish:
   - the user-facing intent and implementation approach;
   - type (`feat`, `fix`, `refactor`, `docs`, `test`, `perf`, `chore`);
   - any breaking changes, migrations, rollout constraints, or unvalidated risk;
   - testing actually performed. Never claim testing that did not run.

3. Keep the PR focused. Exclude unrelated existing worktree changes. If the branch combines independent concerns or is unusually large, recommend splitting it rather than obscuring the scope.

4. Compose a concise imperative title, preferably conventional-commit style and under 72 characters. Write a body containing only applicable sections:

   ```md
   ## Summary

   - <meaningful change and why>

   ## Testing

   - <commands actually run and their outcomes; identify failures and blockers>

   ## Evidence

   - <tested revision, observable scenario results, and published screenshot/recording links>

   ## Breaking changes

   - <migration impact, if any>
   ```

   Follow repository validation requirements even when the user only says "create PR". For user-visible changes, load `test-t3-app`, exercise the changed behavior in a real client, and capture a final screenshot. Record motion/timing changes. A baseline smoke test is not proof of the specific feature. Publish applicable media using `github-pr-media`; local file paths are not PR evidence. Inspect the published PR and links before reporting success. If validation or publication is blocked, explicitly report the blocker and do not claim the PR is verified. Documentation-only changes may say "Not applicable" with the reason. Describe the why and externally observable behavior, not a file-by-file diff.

5. Treat "create PR" as authorization to create a focused branch if needed, commit the task's changes, push, and create the PR. Do not ask for confirmation of the title, body, base, or these routine steps. Infer sensible defaults from repository context; ask only when a genuine blocker cannot be resolved safely.

6. Check GitHub CLI authentication and an existing PR for the branch:

   ```sh
   gh auth status
   gh pr view --json url --jq .url
   ```

   If a PR exists, skip creation and proceed to step 8 with its URL. Associate it with the current thread, but update its GitHub metadata or branch only with explicit user approval. Otherwise, commit any task-scoped changes and push if the branch has no upstream or commits have not been pushed:

   ```sh
   git push -u origin "$(git branch --show-current)"
   ```

7. Create the PR without another confirmation:

   ```sh
   gh pr create --base "<base>" --title "<title>" --body "<body>"
   ```

   Omit `--draft` for normal PR creation. Use `--draft` only for an explicitly requested draft PR; use `--reviewer` and `--label` only when requested.

8. Call the T3 `associate_pull_request` tool with the existing PR URL from step 6 or the newly created PR URL from step 7. This publication-only step is required so the current thread's sidebar PR badge is durable; do not infer association from the checked-out branch. Return the PR URL after the association succeeds.

   If association fails, report the existing or created PR URL and the association blocker. Retry association when appropriate, never PR creation.

## Safety rules

- A request to create a PR authorizes task-scoped commits and a normal push. Do not amend, rebase, force-push, or discard changes unless separately requested.
- Never include credentials, generated secrets, or unrelated files.
- Surface authentication, push, base-branch, and existing-PR failures directly; do not fabricate a successful PR.
