# Troubleshooting

In order of the pipeline. Each entry: symptom → cause → fix. Read this
before improvising; every item below cost a real debugging cycle.

## Toolchain

- `maestro: command not found` → never installed. Do not use brew (its
  formula demands a sudo CLT upgrade). Download the `cli-<v>` `maestro.zip`
  from GitHub releases plus a Temurin JRE 21 aarch64 tarball; see
  environment.md. Check with `maestro --version` under the exported env.
- `Unable to locate a Java Runtime` → `JAVA_HOME` unset or wrong. Point it
  at the extracted `.../Contents/Home`, not the tarball root.
- `Multiple devices connected` → pass `--device <UDID>` explicitly;
  `--platform ios` alone is not enough.

## Metro / bundle

- Dev-client error screen (`Failed to load app from http://…`) on launch →
  URL or bind problem. Confirm Metro answers (`curl …/status`), then check
  the bind: Node 24 defaults to IPv6, so `127.0.0.1` is refused while
  `localhost` works. Restart Metro with
  `NODE_OPTIONS=--dns-result-order=ipv4first`.
- `/index.bundle` → 404 `Unable to resolve module ./index from <repo>/.` →
  expected: Metro root is the repo root. Launch the client with the
  manifest URL (trailing slash) so it resolves
  `/apps/mobile/index.ts.bundle` itself. Verify via
  `curl …/ | head -c 800` (manifest contains `launchAsset.url`).
- `expo run:ios` opens a LAN-IP URL the sim cannot reach → relaunch with
  the `127.0.0.1` manifest URL via `simctl openurl` (environment.md).
- Bundle builds but the app sits at the launcher → tap the icon or the
  `RECENTLY OPENED` entry; dismiss the dev-menu onboarding with Continue.
- `git checkout <base> -- <paths>` for before-captures triggers rebundle
  automatically; a cold relaunch guarantees no Fast Refresh staleness.

## Backend / web

- `pnpm dev` → `Unrecognized flag: --filter in command dev-runner` → the
  committed dev-runner/vp combination is broken in this checkout. Run
  server and web directly per environment.md; do not fix dev-runner inside
  a feature loop (report it separately).
- New web process → `Port <n> is already in use` → a stale owner survived
  `pkill`; kill by port (`lsof -ti :<port> | xargs kill -9`). A stale
  server keeps old env vars baked into responses — always confirm the
  listener PID is the new one.
- Web shows `Something went wrong / Failed to fetch` + CORS errors naming
  `/api/auth/session` → `VITE_DEV_SERVER_URL` missing or mismatched
  between web bundle and server. Both processes need the identical value;
  hostnames must match exactly (`localhost` vs `127.0.0.1` mismatch
  re-triggers CORS even with the variable set).
- Server `/pair` → 503 `No static directory configured and no dev URL
set` → server lacks `VITE_DEV_SERVER_URL`; restart it with the variable.
- `The environment credential is invalid` on submit → stale/consumed
  single-use token. Generate exactly one fresh token and submit once;
  repeated `pair` invocations invalidate earlier tokens.
- Mobile `Connected environment <a> does not match <b>` (or red
  `Connection failed` in Environments) → backend was restarted and its
  environment ID rotated. Never restart mid-loop; recover by adding a new
  pairing, not by debugging sync.

## Maestro driving

- `tapOn` reports success but nothing happens → it hit the first of
  several matches (screen title shadows the button). Re-run with
  `index: 1` after checking `hierarchy` bounds.
- Fields show typed text but submit changes nothing → the tap focused a
  label, not the input. Tap the field's current **value**, then
  `eraseText`, then `inputText`.
- Submit taps do nothing with no error → the host field holds a hostname:
  pairing forces `https://` for non-IP hosts and TLS fails silently
  against the plain-HTTP server. Use `127.0.0.1:<port>`.
- `inputText` into the thread composer reports success with empty value →
  `T3ComposerEditor` ignores synthetic typing. Route content through the
  web client; do not retry typing.
- `extendedWaitUntil` failing right after an action → the list was still
  syncing (cold start ~60s) or the element text differs (rows render
  `"<title>, <time>"`). Screenshot before re-running.
- `osascript` keystrokes → `not allowed to send keystrokes`: no
  Accessibility permission in this environment. No workaround; use the
  web client for text.
- Collaborative-browser snapshots failing while navigation works →
  snapshot service degraded; prefer Maestro screenshots for native and
  Playwright screenshots/DOM dumps for web in that session.
