# Maestro patterns

Flow files live in `/tmp` (never the repo) and run as:

```bash
maestro --device "$T3_SIM_UDID" test /tmp/<flow>.yaml
```

Every flow starts with `appId: com.ronakguliani.t3code.dev`.

## Proven selectors

- `tapOn` matches **regex** against accessible names. List rows combine
  title and timestamp (`"New thread, 28m"`), so tap `"New thread.*"` —
  a bare `"New thread"` may not match.
- Duplicate text matches the **first** node, which is often wrong: the
  `Add Environment` screen title shadows the submit button. Disambiguate
  with `index: 1` (verified via `hierarchy` bounds).
- Icon-only buttons can expose SF symbol names: the Environments `+`
  reads as `"add"`.
- Confirm any uncertain target first: `maestro --device <UDID> hierarchy`
  emits JSON with text, bounds, and enabled state. Walk it with a small
  script rather than guessing twice.

## Text entry

- `eraseText` clears the focused field. `clearText` does not exist.
- `inputText` appends to the focused field; always focus first by tapping
  the field's **current value**, not its label (tapping a label may not
  move focus).
- `inputText` does **not** work in `T3ComposerEditor` (custom native
  composer): taps and typing report success but the value stays empty.
  Create message content through the web client (fixtures reference).
  Standard `TextInput` fields (host, pairing code) work normally.
- `hideKeyboard` before tapping buttons the keyboard can cover.

## Waiting and screenshots

- Gate on visibility, never sleeps:
  `extendedWaitUntil: { visible: "...", timeout: 60000 }` (or `notVisible`
  for dismissals). Cold-start sync takes ~60s; pair-submit up to 60s.
- `takeScreenshot` takes a **name**, not a path. Absolute paths fail
  (`resolves outside this run's takeScreenshot output folder`). Outputs
  land under `~/.maestro/tests/<timestamp>/<flow>/takeScreenshot/<name>.png`.
  Retrieve the newest with
  `find ~/.maestro -name "<name>.png" -mmin -N`.
- Failing steps leave debug screenshots in the run directory — check them
  before re-running blind.

## Navigation notes

- Back chevron has no label; the previous screen's title (`"Threads"`)
  acts as the back target.
- Native context menus (long-press via `longPressOn`) expose items by
  text (`"New subchat"`); the row menu also carries Settle/Snooze/Pin.
- The dev-client launcher (`Development Build / Enter URL manually`) means
  the bundle URL was lost: relaunch with the manifest URL from
  environment.md, or tap the `RECENTLY OPENED` entry.
- "No threads yet" on cold start is normal until sync populates (~60s);
  "Environment unavailable ... does not match ..." means the live backend
  serves a different state directory than the paired era (different
  `T3CODE_HOME` or dev-URL flag — same-config restarts preserve identity).
  Verify the flags first, then re-pair; do not debug it as a product bug.
