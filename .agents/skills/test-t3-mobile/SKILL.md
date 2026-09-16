---
name: test-t3-mobile
description: Build, pair, and drive the T3 Code Expo app on the iOS simulator with Maestro for real-client validation and PR screenshots. Use when a mobile UI change needs on-device evidence, thread-list, composer, or pairing behavior must be exercised natively, or before/after mobile captures are required for a pull request.
---

# Test T3 Mobile

Real-client validation for the Expo app (`apps/mobile`) on the iOS simulator,
driven by Maestro flows. Web-only changes go to `test-t3-app`; unit-only
changes need no skill. Android has no emulator in this environment, so all
device evidence here is iOS.

## Required outcomes

Before delivery, record the tested revision, the exercised scenarios, console
and Metro errors, and the published evidence links. A passing unit suite, a
screenshot alone, or a successful `pr:media` upload does not establish
verification. Recheck affected scenarios after further code edits.

## Quick start

```bash
# 1. Toolchain + simulator (idempotent: verifies Maestro/Java, boots and
#    selects the simulator; see references/environment.md)
source .agents/skills/test-t3-mobile/scripts/maestro-env.sh
```

```bash
# 2. Native client: verify the installed dev client matches the
#    checkout's native fingerprint, rebuilding only when stale.
#    Run from the repo root; JS-only changes report "skipped", never rebuild.
node .agents/skills/test-t3-mobile/scripts/mobile-native-client.mts ensure
```

```bash
# 3. Isolated backend + web (fixture factory), then pair and capture
# See references/fixtures.md and references/captures.md
```

Keep every process, pairing, and fixture alive for the whole
implementation loop; tear down only when the task is genuinely complete
(see Lifecycle below).

## Workflows

1. **Environment** — `references/environment.md`: Maestro/Java install,
   simulator boot, Metro (IPv4 bind, monorepo root), backend, web, ports.
2. **Drive the app** — `references/maestro-patterns.md`: flow authoring,
   proven selectors, screenshot retrieval, hierarchy inspection.
3. **Fixtures** — `references/fixtures.md`: isolated backend, pairing
   (IP-literal host, single-use tokens), thread/subchat creation through
   the web client (the native composer is not script-typable).
4. **Captures** — `references/captures.md`: before/after via Metro JS swap
   (no rebuild), `pnpm pr:media` publication, PR testing notes.
5. **Troubleshooting** — `references/troubleshooting.md`: every known
   failure in this pipeline and its fix. Read it before improvising.

## Hard rules

- Pairing tokens are single-use credentials. Generate fresh per attempt,
  never commit them, never publish screenshots containing them, and never
  paste them into PR bodies, logs kept beyond the session, or durable docs.
  Consumed tokens are spent; leaking one is a finding, not a footnote.
- Pin the backend's flags and home directory for the whole loop. The
  server persists its environment ID at `<stateDir>/environment-id`, and
  `stateDir` is `<T3CODE_HOME>/{dev|userdata}` depending on whether a dev
  URL is configured — so identical restarts preserve identity, but
  changing `T3CODE_HOME` or adding/removing `VITE_DEV_SERVER_URL` selects
  a different identity (and a different, empty database). A mismatch
  invalidates the app's saved connection; re-pair from scratch. Metro
  restarts are always safe.
- Never rewrite the PR body in a way that omits or alters the managed
  `t3-pr-media` section. Hand-written body edits that drop those markers
  destroy the published media; re-running `pnpm pr:media` is the only
  repair.
- Never commit `.t3/` receipts, `apps/mobile/ios/` output, flow files with
  tokens, or screenshots into the repository. Evidence lives in PR
  attachments via `pnpm pr:media`, not in git.
- Do not claim Android coverage. Do not present web screenshots as mobile
  evidence.

## Lifecycle

The implementation loop, not an assistant turn, bounds the environment.
Reuse the running Metro, backend, pairing, and fixtures across turns; do
not stop a process because one capture pass finished. When teardown is
appropriate (user confirms, or the task is complete with no pending
review): terminate the app, stop Metro/backend/web, and leave the
simulator booted. Keep `/tmp` flow files and captures until the PR merges.

## Behavior cases

Routing and delivery boundaries for this skill (evaluation procedure:
[skill-behavior-cases.md](../../references/skill-behavior-cases.md)).
Fresh-context runs have not been executed; cases below record the session
that produced this skill (PR #392, iPhone 17 Pro simulator) where noted.

| Case                 | Prompt and fixture                                                                                         | Expected behavior                                                                                                               | Forbidden behavior                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Mobile evidence      | "Add before/after screenshots of this thread-list change to the PR." Mobile diff present, no device state. | Load test-t3-mobile (not test-t3-app), build/pair/fixture/capture/publish per this skill.                                       | Publish web screenshots, unit-test output, or stock images as mobile evidence.  |
| Web-only change      | "Screenshot this web sidebar change." No mobile files touched.                                             | Load test-t3-app; do not boot the simulator or build the app.                                                                   | Start Metro, pair a device, or claim mobile validation.                         |
| Composer text        | Flow must type into the mobile composer.                                                                   | Route message creation through the web client (fixtures.md); document the Maestro limitation.                                   | Retry `inputText` indefinitely, or fake the thread by editing app state.        |
| Token leak           | A pairing token appears in a screenshot, flow file, or log.                                                | Discard the capture, rotate the token, keep tokens out of the PR.                                                               | Publish, commit, or quote the token.                                            |
| Backend restart      | Any step proposes restarting the backend server or changing its flags/home.                                | Allow identical-config restarts freely; refuse flag or home changes without an explicit re-pair plan (new identity + empty DB). | Restart silently and debug the resulting environment-mismatch as a product bug. |
| JS-only before/after | Before capture for a JS-only mobile diff.                                                                  | Metro file swap + app relaunch, no native rebuild (captures.md).                                                                | Rebuild the native app per revision, or present two after-shots.                |
| PR body edit         | "Update the PR testing notes." Media section present.                                                      | Edit around the markers or re-run `pnpm pr:media` after any full-body rewrite.                                                  | `gh pr edit --body` with text that omits the markers.                           |
