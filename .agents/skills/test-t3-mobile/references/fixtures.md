# Fixtures

Threads live server-side (SQLite under the isolated `T3CODE_HOME`), so one
fixture serves every capture revision. Provider turns fail in the sandbox
(no credentials) — threads persist with failed status, which is fine and
representative for list UI. Never write SQLite directly; create everything
through product UI.

## Pair the mobile app (once per backend boot)

The Add Environment sheet needs an **IP-literal host**: `pairing.ts`
`buildPairingUrl` forces `https://` for hostnames, which fails against the
plain-HTTP dev server. `127.0.0.1:<server-port>` yields `http://`.

1. Fresh token: `node apps/server/src/bin.ts pair --base-dir <home>` (each
   issue may invalidate the previous one; generate immediately before use).
2. Maestro: open Add Environment, tap the HOST placeholder, `eraseText`,
   type `127.0.0.1:<server-port>`; tap the code placeholder, `eraseText`,
   type the token; `hideKeyboard`; tap submit with `index: 1`.
3. Gate on the sheet dismissing (`notVisible: "PAIRING CODE"`), then confirm
   the Environments screen shows green `Connected` for the new entry.
4. A stale red entry from a pre-restart pairing is expected if the backend
   was ever restarted; leave it (it contributes no rows).

## Parent + subchat via the web client

Pair Playwright at `http://localhost:<web-port>/pair#token=<fresh-token>`
(one token per script run; generate inside the run command).

1. New task in the target project: click `new-thread-button` (force click;
   the icon button is not actionably visible), fill the composer textbox,
   click Send. The turn fails on provider probe — the thread persists.
   Record the thread id from the resulting URL for later row targeting.
2. Subchat: right-click the parent row
   (`getByTestId("thread-row-<parent-id>")`, `button: "right"`), click
   `New subchat` (exact text), fill the draft composer, Send. The child
   thread carries `parentThreadId`; the sidebar shows it under the parent.
3. Assert both titles appear in the web sidebar before touching the
   simulator — a missing child means the fixture (not the app) is broken.

## Mobile verification of the fixture

Relaunch the app cold (`simctl terminate` + tap the icon) and wait out the
~60s sync; assert the parent title is visible, then screenshot. If only
stale rows appear, the saved connection predates a backend restart —
re-pair rather than rebuilding anything.
