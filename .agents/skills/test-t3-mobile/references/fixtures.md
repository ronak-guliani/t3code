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

Preferred — deterministic pairing via AgentDevice (fresh credential per
attempt, never reused or logged):

```bash
.agents/skills/test-t3-mobile/scripts/pair-client.sh \
  <server-port> <base-dir> <device-reachable-backend-origin> \
  "$agent_device_command" "${agent_device_target_args[@]}"
```

It mints via `node apps/server/src/bin.ts auth pairing create` (`--ttl
15m --label agent-mobile`), parses the `Pair URL:` line, and deep-links
T3 Code Dev to the existing pairing route with `autoConnect=1`. For a
backend on the device host, use `http://127.0.0.1:<server-port>` on iOS
or `http://10.0.2.2:<server-port>` on Android.

Fallback — manual Maestro pairing (when AgentDevice is unavailable):

1. Fresh token: `node apps/server/src/bin.ts auth pairing create
--base-dir <home> --base-url http://127.0.0.1:<server-port>`.
   Pairing links are independent rows — issuing a new one does not revoke
   earlier unconsumed links — but generate-then-submit promptly anyway:
   interleaved generations make it ambiguous which credential was
   submitted, and each success consumes its link.
2. Maestro: open Add Environment, tap the HOST placeholder, `eraseText`,
   type `127.0.0.1:<server-port>`; tap the code placeholder, `eraseText`,
   type the token; `hideKeyboard`; tap submit with `index: 1`.
3. Gate on the sheet dismissing (`notVisible: "PAIRING CODE"`), then confirm
   the Environments screen shows green `Connected` for the new entry.
4. A stale red entry means the app holds a connection for a different
   server identity (different state directory — e.g. flags changed
   mid-loop), not merely a restarted process. Leave it (it contributes no
   rows); its presence is a signal to double-check flag stability, not to
   rebuild anything.

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
stale rows appear, the saved connection targets a different server
identity than the live backend (different `T3CODE_HOME` or dev-URL flag
than the paired era) — verify the flags, then re-pair rather than
rebuilding anything.
