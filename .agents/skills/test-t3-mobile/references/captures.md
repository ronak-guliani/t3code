# Captures

## Before/after without rebuilding

The native build is revision-independent; only Metro JS changes between
revisions. Capture both sides from one build:

1. **After**: current PR code in the worktree, Metro bundled, app
   relaunched cold, fixture synced, screenshot (`<name>-after.png`).
2. **Before**: check out the base revisions of the changed source files
   only — `git checkout <merge-base> -- <paths>`, never a branch switch:
   ```bash
   BASE=$(git merge-base HEAD origin/main)
   git diff $BASE HEAD -- <paths> > /tmp/pr-changes.patch  # safety net
   git checkout $BASE -- <paths>
   ```
   Wait for Metro to rebundle, terminate + relaunch the app cold, wait out
   sync, screenshot (`<name>-before.png`).
3. **Restore**: `git checkout HEAD -- <paths>` (or `git apply` the saved
   patch), confirm `git status` is clean, relaunch once to prove the
   restore took effect.
4. Metro regenerates `apps/mobile/uniwind-types.d.ts` during bundling;
   restore it (`git checkout -- <path>`) before finishing so generated
   churn never enters a commit or a capture diff.

## Publish

```bash
pnpm pr:media -- <PR-URL> <capture files...>
```

It decodes (PNG/JPEG/WebM), uploads to PR attachments, and maintains its
own `t3-pr-media` body section at the PR head revision. Re-running with
identical head + files reuses uploads. Verify the rendered images on the
PR afterwards; local paths and CI artifacts are not evidence.

**The managed section is load-bearing.** Never rewrite the PR body with
`gh pr edit --body/--body-file` using text that omits the
`t3-pr-media` markers — that deletes the published media. Edit notes
around the markers, or re-run `pnpm pr:media` to restore the section.

## PR testing notes

Record: tested revision (sha), exercised actions, observations (what each
capture shows, including expected-but-unrelated elements such as PR
badges resolving the fixture branch), and limitations. Standard
limitations for this pipeline: fixture depth used, iOS-only, VoiceOver
announcements covered by unit test unless exercised on-device, no scroll
or motion capture unless recorded.

## Secret review (before every publish)

Open each capture at full size and check: no pairing tokens or codes, no
pairing URLs, no filesystem paths, no truncated secrets in banners or
error text. Discard and retake on any hit; rotate any exposed token.
Provider-failure banners are publishable only after this check — the one
observed here embedded an absolute repo path, so web captures stay local
and only the mobile list captures publish.
