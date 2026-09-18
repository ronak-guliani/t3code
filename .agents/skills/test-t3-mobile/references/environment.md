# Environment

Long-lived processes for mobile validation. Start once per loop, reuse
across turns. All commands run from the repository root unless noted.
Isolated backend state must never be the shared `~/.t3` directory.

## Toolchain (one time per machine)

Maestro and Java live outside brew because the brew formula is blocked on
outdated Command Line Tools (updating those needs sudo):

```bash
mkdir -p ~/.local/maestro ~/.local/java
curl -sL -o ~/.local/maestro/maestro.zip \
  https://github.com/mobile-dev-inc/maestro/releases/download/cli-2.10.0/maestro.zip
unzip -q -o ~/.local/maestro/maestro.zip -d ~/.local/maestro
curl -sL -o ~/.local/java/jre.tar.gz \
  "https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jre/hotspot/normal/eclipse"
tar -xzf ~/.local/java/jre.tar.gz -C ~/.local/java
```

Every Maestro invocation needs (see `scripts/maestro-env.sh`):

```bash
export JAVA_HOME="$HOME/.local/java/jdk-21.0.12.1+1-jre/Contents/Home"
export PATH="$HOME/.local/maestro/maestro/bin:$PATH"
export MAESTRO_CLI_NO_ANALYTICS=1
```

Pin these versions in the skill when upgrading; Maestro 2.x screenshot
rules below depend on them.

## Simulator

```bash
xcrun simctl boot "iPhone 17 Pro"
xcrun simctl list devices | grep Booted   # capture the UDID; never hardcode it
```

Select the device explicitly on every Maestro call (`--device <UDID>`);
`--platform ios` alone fails when Maestro sees more than one device.

## Metro (JS server)

Preflight needs Xcode 26.4+ (`node apps/mobile/scripts/ios-preflight.mts`).
Prebuild generates gitignored `ios/` output:

```bash
# from apps/mobile
node scripts/ios-preflight.mts
APP_VARIANT=development EXPO_NO_GIT_STATUS=1 ./node_modules/.bin/expo prebuild --clean --platform ios
```

Two Metro behaviors that waste hours if unknown:

1. **IPv4 bind.** Under Node 24, `expo start --localhost` binds IPv6-only
   (`localhost` works, `127.0.0.1` is refused, and the simulator needs the
   latter). Always start Metro with:
   `NODE_OPTIONS=--dns-result-order=ipv4first expo start --localhost --port 8081`
2. **Monorepo root.** Metro's project root is the repository root, so the
   bundle path is `/apps/mobile/index.ts.bundle`. The dev client must be
   pointed at the manifest URL **with trailing slash** so it resolves the
   entry itself; a bare host URL makes it request `/index.bundle` → 404:
   `exp+t3-code-rg://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081%2F`

Build, install, and launch once per native change (10–20 min first run;
JS-only changes never need this). Prefer the fingerprint-gated entrypoint
from the repo root — it runs the same prebuild/run below only when the
installed client is missing or its native fingerprint is stale, and just
re-points Metro at the current bundle otherwise:

```bash
node apps/mobile/scripts/mobile-native-client.mts ensure
```

Manual equivalent (what `ensure` runs when stale), from `apps/mobile`:

```bash
# from apps/mobile
APP_VARIANT=development EXPO_NO_GIT_STATUS=1 ./node_modules/.bin/expo run:ios --no-bundler --device "$T3_SIM_UDID"
xcrun simctl openurl "$T3_SIM_UDID" "exp+t3-code-rg://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081%2F"
```

Dev-client bundle id is `com.ronakguliani.t3code.dev`. Dismiss the dev-menu
onboarding sheet (Continue) if it appears.

## Backend (isolated, pairing authority)

`pnpm dev` is unusable here: dev-runner spawns `vp run dev --filter …`
and this vp version forwards `--filter` into the script (`Unrecognized
flag`). Run the server directly from `apps/server`:

```bash
T3CODE_HOME=/tmp/t3code-<test> T3CODE_PORT=13776 T3CODE_NO_BROWSER=1 \
  VITE_DEV_SERVER_URL=http://localhost:5736 \
  nohup node --watch src/bin.ts > /tmp/t3-server.log 2>&1 &
```

- `T3CODE_HOME` must be an isolated directory (repo `.t3/` or fresh
  `/tmp` path), never the shared home.
- `VITE_DEV_SERVER_URL` is required: without it `/pair` returns 503
  ("No static directory configured and no dev URL set").
- **Pin the backend's flags and home for the whole loop.** The server
  persists its environment ID at `<stateDir>/environment-id`, where
  `stateDir` is `<T3CODE_HOME>/{dev|userdata}` depending on whether a dev
  URL is configured — so restarts with identical config preserve identity,
  but changing `T3CODE_HOME` or adding/removing `VITE_DEV_SERVER_URL`
  selects a different identity (and a different, empty database). Settle
  these values before the first boot and pairing. If the app reports
  `Connected environment <actual> does not match <expected>`, the live
  server is serving a different state directory than the paired era:
  verify the flags/home, then re-pair from scratch (and recreate fixtures
  if the database differs). Metro restarts are always safe.
- Fresh pairing token (single-use; issue immediately before use):
  `node apps/server/src/bin.ts pair --base-dir <same-home-dir>`

Default ports are server 13773 / web 5733 / Metro 8081; derive offsets per
worktree when several loops run (13776/5736 used here). Confirm each
listener with `curl` + `lsof -i :<port>` before driving the app.

## Web (fixture factory only)

The mobile composer is not script-typable, so thread fixtures are created
through the web client. From `apps/web` (after killing any stale owner of
the port — a previous env mismatch otherwise survives silently):

```bash
PORT=5736 VITE_HTTP_URL=http://localhost:13776 VITE_WS_URL=ws://localhost:13776 \
  VITE_DEV_SERVER_URL=http://localhost:5736 T3CODE_HOME=/tmp/t3code-<test> \
  ./node_modules/.bin/vp dev
```

All three `VITE_*` vars are load-bearing: `VITE_DEV_SERVER_URL` enables
the same-origin request rewrite (without it every API call dies on CORS),
and the server needs the same value to proxy `/pair`. Keep hostnames
consistent (`localhost` everywhere, never mixed with `127.0.0.1`) or CORS
returns. Playwright (repo-pinned `playwright` package; Chromium in
`~/Library/Caches/ms-playwright`) pairs at
`http://localhost:5736/pair#token=<fresh-token>`.
