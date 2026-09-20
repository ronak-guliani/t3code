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

4. Compose a concise imperative title, preferably conventional-commit style and under 72 characters. Match upstream `.github/pull_request_template.md` format, with `Problem` as the first heading. Write a body containing only applicable sections:

   ```md
   ## Problem

   - <problem being solved, with linked issue if any>

   ## What Changed

   - <meaningful change and why, kept scope-tight>

   ## Why

   - <problem being solved and why this approach is the right one>
   - <breaking changes, migrations, or rollout constraints, if any>

   ## UI Changes

   - <tested revision, observable scenario results, and published screenshot/recording links>
   - <delete this section if not applicable>

   ## Checklist

   - [ ] This PR is small and focused
   - [ ] I explained what changed and why
   - [ ] I included before/after screenshots for any UI changes
   - [ ] I included a video for animation/interaction changes
   ```

   Follow repository validation requirements even when the user only says "create PR". Never claim testing that did not run; include commands actually run and their outcomes in `Why` or `UI Changes` as appropriate, identifying failures and blockers. For user-visible changes, load `test-t3-app` and exercise the actual feature with meaningful data in a real client. Capture before/after screenshots; record motion or timing after authentication. Use `pnpm pr:media -- <PR URL> <capture files...>` to upload those captures and verify delivery. Describe the tested revision, actions, observations, diagnostics, and limitations in the PR notes, not a separate feature-report manifest. Recheck affected scenarios after further code edits. `pnpm test:self` is only a pairing/reconnect smoke check; run it when relevant and never substitute its captures, a generic authenticated app, or a successful upload for feature testing. Remove obsolete pairing-only PR evidence when replacing it with feature captures. Inspect the published media before reporting success. If validation or publication is blocked, say so explicitly. Documentation-only changes may delete the `UI Changes` section. Describe the why and externally observable behavior, not a file-by-file diff.

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
