# T3 Code RG Mobile

Our independently configured build of the upstream-derived React Native app. It stays in this
monorepo with the fork server, `packages/contracts`, and `packages/client-runtime`; do not create
a second copy of those packages for mobile.

The mobile source import is pinned to `pingdotgg/t3code` commit
`de1b798c6ed4223cabd64f56eadcc8f512963043` (September 5, 2026 UTC),
using Expo SDK 57 and React Native 0.86.3. This includes the mobile fixes after the earlier
comparison target `940e8233c227a186044078e99e45e1933eb525e4`.
Owned build configuration and app icons are retained from the fork.
Source import, client/server compatibility, and signed device acceptance are separate gates;
an imported directory or successful JavaScript export alone is not a release.
The client RPC schema includes capability-dependent upstream methods without adding unsupported
handlers to the fork server. Older servers retain inline image uploads and socket snapshots;
file uploads, usage, provider feedback, and other optional APIs require explicit capability support.

The app supports **T3 Connect** account sign-in and **Direct Connect** pairing/session authentication.
Connect uses the managed relay without requiring a domain or phone VPN. For Direct Connect across
networks without a phone VPN, configure the fork's [owned Remote Access](../../docs/background-service.md#owned-remote-access-no-phone-vpn)
and pair through its permanent HTTPS hostname. Tailscale HTTPS remains an alternative.
Multiple clients can pair independently, and each client can save multiple host environments.
Remote APNs/Live Activity push, telemetry export, and OTA updates remain disabled independently
of Connect. Desktop production settings cannot enable them. Local widgets/Live Activities remain included.
Configuring an owned Expo project does **not** turn OTA updates back on.
Both native binaries include Clerk's auth modules; configured builds expose the existing native
sign-in screen. Set `MOBILE_CONNECT_ENABLED=false` to hide Connect and keep Direct Connect only.

## T3 Connect

Mobile builds use the public Connect identifiers in the root `.env.example` by default.
Root `.env`, `.env.local`, and process/EAS environment variables override those defaults, in that
order. To use another deployment, configure all three together:
`T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`.
The relay must be an HTTPS origin and trust the matching Clerk instance/JWT template.
No Clerk secret key belongs in mobile configuration.

1. Keep the desired host server running, then run `t3 connect link` and `t3 connect status`
   against that host's home directory. Wait for linked and online.
2. Rebuild and install this mobile app. Existing Direct Connect-only binaries lack the iOS
   auth module; restarting Metro or refreshing JavaScript is not sufficient.
3. Open **Settings**, choose the account **Sign in** row, and sign into the same account used
   on the host. The Connect onboarding sheet lists the account's environments.
4. Select the host and connect. Existing Direct Connect environments remain available without
   requiring account sign-in.

The native Clerk plugin adds Sign in with Apple to the app entitlement. Device distribution needs
an updated provisioning profile for this fork's bundle identifier.

For the production Connect deployment, `.env.example` sets
`MOBILE_CLERK_IOS_REDIRECT_URL=com.t3tools.t3code://callback`. The pinned Clerk Expo patch forwards
this callback to the native SDK and registers its scheme as an additional iOS callback alias.
The fork retains its own bundle identifier, primary URL scheme, signing team, and keychain service;
it does not read the official app's stored credentials. This is an iOS-only override.

When using another Clerk deployment, set that variable to its authorized custom-scheme callback
or set it to an empty string to use the SDK's default `{bundleIdentifier}://callback`. Merely adding
a URI locally does not authorize it on Clerk. Changing the native callback requires a new binary;
use `pnpm ios:update` and install the resulting Preview build.

## Nested chats

Long-press a chat and choose **New subchat**, or use **Chat actions** in its header.
The draft inherits the parent's provider instance, model options and checkout without
copying conversation history. Choose a new worktree explicitly to isolate its workspace.
Each parent has its own persisted subchat draft; offline queued creation and rejection
recovery retain parentage, model options and checkout selection.
If a rejected queued subchat's parent is unavailable, its content and settings are recovered
to the project's new-chat draft without parentage. Review and send it explicitly; recovery
never sends it automatically.

Home and the iPad sidebar keep descendants with their root in both list modes. Quiet trees
start collapsed; active work and selected descendants reveal their ancestors. Expansion
preferences persist on the device. Logical depth is unlimited; indentation stops increasing
after four levels to keep narrow screens usable. Approval, input and work status roll up to
ancestors. Durable child lifecycle updates show a **Child update** indicator until the parent
is viewed in the foreground.
Search reveals matching descendants on collapsed shelves and keeps their ancestry without
showing unmatched sibling branches.

**Go to parent chat** navigates up one level. **Decouple chat** makes the selected chat a root
without changing its checkout. Archive includes active descendants and is blocked while that
subtree has active work. Restore affects only the selected chat. Delete removes only the
selected chat; surviving children become roots when their parent is absent.

Provider background agents appear as display-only children. Opening one navigates to its
parent; completed runs can be dismissed locally. Unlike web, mobile does not focus a specific
agent work-log entry or provide hover previews and keyboard tree traversal.
Pending unsent subchats remain in the existing Queued section until creation is acknowledged.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

The variants have independent native identities, widget IDs, app groups, and URL schemes:

| Variant       | Display name       | iOS bundle / Android package      | URL scheme          |
| ------------- | ------------------ | --------------------------------- | ------------------- |
| `development` | T3 Code RG Dev     | `com.ronakguliani.t3code.dev`     | `t3code-rg-dev`     |
| `preview`     | T3 Code RG Preview | `com.ronakguliani.t3code.preview` | `t3code-rg-preview` |
| `production`  | T3 Code RG         | `com.ronakguliani.t3code`         | `t3code-rg`         |

The development ID intentionally preserves this fork's existing dev installation; preview and
production no longer use upstream identifiers. Pair each new installation normally. Do not copy
the official app's credential storage, or change the server's environment ID to match a client.
Existing fork Dev installations retain their storage. The authorized-client list uses the build's display
name, so Dev and Preview sessions are distinguishable.

Use the root-pinned Node/pnpm toolchain and run `pnpm install --frozen-lockfile` at the repository
root. For iOS, install **Xcode 26.4 or newer** and CocoaPods; the deployment target is iOS 18. Physical-device
builds need signing under your Apple team, including the widget extension/app group.
Android needs the Android SDK/JDK. Run the commands below from `apps/mobile`.
No Expo account is required for local builds. Unset `APP_VARIANT` selects development;
unknown variants fail rather than silently selecting a release identity.
Local iOS commands check the active Xcode version before regenerating native projects.
Use `DEVELOPER_DIR` to select a compatible installation without changing the machine-wide
Xcode selection. The EAS profiles use Xcode 26.6, Node 24.18.0, and pnpm 11.10.0.

## Update your iPhone without a cable

From the repository root or `apps/mobile`, run:

```bash
pnpm ios:update
```

This builds the current source using the standalone ad hoc `preview` profile, waits for the
cloud build, and prints an installation link and QR code. Scan the QR code with your iPhone,
open the link, and confirm **Install**. It replaces **T3 Code RG Preview** using the same bundle
identifier; do not delete the old app first if you want to keep its local data.

No cable, local Xcode, Metro, or TestFlight is needed. The Mac and phone do not need to be on
the same network. You need Internet access, an Expo account with access to this project, and
your iPhone registered in the ad hoc profile (`ronniefone` is already registered). EAS may ask
for Apple authentication when signing credentials need refreshing; enter it directly in your
terminal, not in chat.

The command creates a new cloud build and uses EAS build quota; it is not an instant JavaScript
update. iOS requires installation confirmation, so the script cannot silently replace the app.
OTA updates remain disabled. To reinstall an existing build without rebuilding, open that build's
installation page in the Expo project dashboard on your phone.

## Development

Start Metro for the dev client:

```bash
pnpm dev:client
```

Build and run the local iOS dev client:

```bash
pnpm ios:dev
```

Build and run the local iOS preview app with an embedded Release bundle (no Metro dependency):

```bash
pnpm ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript pnpm ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
pnpm config:dev
pnpm config:preview
pnpm config:prod
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools
are reported as warnings and skipped locally. The tool list is in `apps/mobile/Brewfile`.

The `ios:*` and `android:*` commands regenerate the ignored native folders; put persistent
native changes in config plugins/modules, not generated projects. Both prebuild and compilation
receive the same explicit variant. Android preview/production also bundle JavaScript in Release
mode. Local release builds are not a substitute for store signing and submission.

## Direct Connect acceptance

The no-Clerk direct path requires a reachable HTTPS origin. Hosted browsers will block an
`http://` API or `ws://` socket as mixed content, so use the Tailscale HTTPS URL for both browser
and mobile pairing; the clients derive `wss://` from that origin.

1. Install Tailscale on the workstation and test device, sign both into the same tailnet, and
   enable HTTPS certificates for the tailnet.
2. From the repository root, build and start the fork server:

   ```bash
   pnpm --filter t3 build
   pnpm start -- --host 127.0.0.1 --port 3773 --no-browser
   ```

3. In another terminal, create and validate the persistent Tailscale HTTPS mapping and one-time client URL:

   ```bash
   pnpm --filter t3 start -- pair --tailscale --label "Physical device acceptance"
   ```

4. Open that HTTPS URL in the matching fork browser build, or in **T3 Code RG Dev/Preview** choose
   **Add environment** and scan/paste the URL. Pairing persists a bearer session; Clerk and the
   managed relay are not involved.
5. Open a thread, send a message, then disable and re-enable Wi-Fi (or background/foreground the
   app). Verify the connection returns to connected, the thread resnapshots without duplicate
   messages, and a queued mobile message drains once.

Automated protocol coverage is available from the repository root:

```bash
pnpm test:direct-connect-smoke
```

It builds the production browser app, starts the production server runtime, and verifies one-time
browser and shared mobile-runtime pairing, persisted bearer sessions, client-scoped HTTP snapshots
and mutations, involuntary socket loss, fresh-ticket reconnect through the shared `WsTransport`,
duplicate-free resnapshot, browser cookie persistence, and owner-side client-session revocation.
It also restarts the server against the same isolated state, replays a committed command ID
without duplicating its mutation, and confirms revocation survives the restart.
The Connect release smoke enforces wakeup probe-versus-replacement behavior, reconnect
subscriptions, environment removal cleanup, and outbox drain. Production acceptance rewrites a
deterministic HTTPS/WSS public shape onto the loopback server, so CI does not require external
credentials, trusted certificates, or an active tailnet.

### Physical-device checklist

Automated coverage does not replace these physical checks. Record device model, OS version, app
variant/version, server commit, network, and result; do not claim iOS or Android evidence unless
the steps were actually run.

1. **LAN pairing:** run `pnpm start -- --host 0.0.0.0 --port 3773 --no-browser`, then
   `pnpm --filter t3 start -- pair --label "LAN device"`. Scan the QR while both devices are on the
   same trusted Wi-Fi. Expect pairing, initial snapshot, mutation sync, and reconnect after toggling
   Wi-Fi. On iOS, record whether ATS permits the plain-HTTP LAN endpoint in the tested build.
2. **Tailscale HTTPS/WSS:** run `pnpm --filter t3 start -- pair --tailscale --label "Tailnet device"`.
   Expect an `https://<machine>.<tailnet>.ts.net/pair#token=...` URL, successful certificate
   validation, and `wss://` live sync. On Android, keep the Tailscale VPN active even if Android
   reports `isInternetReachable=false`; the environment must remain online.
3. **Short interruption:** background the app for less than 10 seconds and return. Expect a quick
   liveness probe with no duplicate snapshot rows and no unnecessary connection replacement.
4. **Long suspension:** background for at least 10 seconds or let the OS suspend the app. Expect the
   old connection to be replaced, a fresh WebSocket ticket, one clean resnapshot, and queued outbox
   messages to drain once.
5. **Wi-Fi loss:** disable Wi-Fi during a mutation, re-enable it, and expect reconnect plus exactly
   one applied mutation. Repeat while Tailscale remains the only route.
6. **Local removal and owner revocation:** remove the environment in the app and confirm local
   cached/outbox data is cleared. Pair again, run `pnpm --filter t3 start -- auth session list`,
   revoke that client with `pnpm --filter t3 start -- auth session revoke <session-id>`, and expect
   the device to disconnect and fail authenticated snapshot/ticket requests.
7. **Cellular and restart:** with Wi-Fi disabled and Tailscale connected on both devices, send an
   image and a message. Restart the isolated server while a message is queued, then confirm the
   queue drains once and the server retains the thread. Repeat revocation while on cellular.

Before testing, confirm `tailscale status` reports a connected tailnet on both devices. A stopped
Tailscale service or a simulator on the host is not cellular evidence. Do not change an existing
shared Serve mapping to run acceptance; use a task-owned endpoint.

After acceptance, stop the server with `Ctrl-C`, remove only the Serve mapping created for this test, and revoke the
acceptance session so its bearer credential cannot be reused:

```bash
tailscale serve status
pnpm --filter t3 start -- auth session list
pnpm --filter t3 start -- auth session revoke <session-id>
pnpm --filter t3 start -- auth pairing list
```

Revoke any still-active pairing credential shown by the final command with
`pnpm --filter t3 start -- auth pairing revoke <pairing-id>`. Do not store the printed pairing URL
or bearer token in shell history, screenshots, logs, or source control.

## Supported server contract

The owned app checks compatibility after fetching the initial server config and before marking
the connection ready. A rejected server remains blocked with an update message, rather than
repeatedly reconnecting or attempting unsupported mutations.

| Server advertisement                                    | Owned app behavior                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ownedMobileProtocolVersion: 1`                         | Accept when the probe and both snapshot completion markers are present |
| No owned version                                        | Accept the existing fork through those same capability checks          |
| Any other owned version                                 | Block and request a matching app/server release                        |
| Missing connection probe or shell/thread resume markers | Block and request a server update                                      |

Package versions alone are not wire compatibility. Bump the owned protocol version when a
required request/response shape changes incompatibly. Keep optional capabilities separately gated.
The server does not impose this policy on the official app or web client. Push, remote Live
Activity delivery, and OTA require separate owned services and remain disabled.

## Connection diagnostics

In Settings, select **Share connection diagnostics** after reproducing a problem. The confirmation
opens the native share sheet with a JSON report containing app/native build, variant, device model
and OS, a random app-session ID, the existing random installation ID, and the last 200 events.
Events live in memory only. Restarting the app or selecting **Clear connection diagnostics** removes
them; nothing uploads automatically. Reports exclude credentials, server URLs, filesystem paths,
prompts, attachment bytes, and raw error bodies.

Use the command ID to match outbox and RPC events to the server's `client command received` and
`client command committed` logs. Server logs include the authenticated session ID and committed
sequence. Connection events include the socket generation, network state, attempt, and failure
category. The app-session ID changes on launch; the installation ID remains stable.

1. A `queued` event without `dispatching` means the local queue has not attempted delivery.
2. `dispatching` and RPC `started` without server receipt indicate a connection/delivery problem.
3. Server commit without client `succeeded` is an ambiguous acknowledgement. Keep the same
   command ID on retry so server deduplication can recover it.
4. Client `acknowledged` means the server accepted the command, not that a provider turn finished.
   Use the thread ID to inspect provider-session and turn lifecycle logs next.

Do not change queue semantics based on a spinner alone. Reproduce the failure and compare this
evidence first. Physical backgrounding, cellular routing, and provider acceptance remain release
checks even when protocol tests pass.

## EAS Builds

The owned project has been created and linked:

| Setting        | Value                                  |
| -------------- | -------------------------------------- |
| Expo project   | `@ronakguliani/t3-code-rg`             |
| EAS project ID | `01272cd5-225c-47d4-978e-a7eb97c9e457` |
| Apple team     | `235XX73T5A`                           |
| EAS CLI        | `23.2.0` (project dependency)          |

These are public identifiers, not credentials. The same owner, project, and team are configured
in the EAS `development`, `preview`, and `production` environments. No root `.env.local` is
needed to select this project's build identity. Local builds still do not require an Expo login.

For a different owned account, override **both** `MOBILE_EAS_OWNER` and
`MOBILE_EAS_PROJECT_ID` in root `.env.local` and the matching EAS environments.
`MOBILE_APPLE_TEAM_ID` overrides the native signing team; also update the submit profile's
`ios.appleTeamId` when distributing under a different team. Partial Expo ownership overrides,
invalid team/project IDs, and upstream ownership are rejected.
Keep signing keys, Apple credentials, and Expo access tokens out of Git.

Use the project-pinned CLI from `apps/mobile`, not an older global `eas` installation:

```bash
pnpm exec eas whoami
pnpm exec eas project:info
```

### Apple authentication and signing

Native configuration selects the owned team for the main app, widget extension, and share
extension. A development certificate does **not** by itself provision these bundle IDs or
create an App Store Connect app. Complete Apple's authentication and signing prompts in an
interactive terminal; never paste passwords, two-factor codes, or API private keys into chat:

```bash
pnpm exec eas credentials:configure-build --platform ios --profile development
pnpm exec eas credentials:configure-build --platform ios --profile testflight
```

Select team `235XX73T5A`. Register/select your device for internal distribution, and create/select
the App Store Connect record for `com.ronakguliani.t3code.preview` for TestFlight.
The share and widget extensions require the corresponding owned app group.
No App Store Connect numeric app ID is guessed or inherited from upstream.

Create a cloud dev-client build or an internal standalone preview:

```bash
pnpm eas:ios:dev
pnpm eas:ios:preview
```

For daily use through TestFlight, build the **preview bundle ID** with store distribution:

```bash
pnpm eas:ios:testflight
APP_VARIANT=preview pnpm exec eas submit --platform ios --profile testflight
```

Submission deliberately has no committed Apple app ID. Select your own App Store Connect
record for `com.ronakguliani.t3code.preview` when prompted. Do not choose the upstream app.
Production uses the separate `com.ronakguliani.t3code` record.
TestFlight is a rolling beta distribution path, not a permanent installation.

### Simulator builds without Apple signing

Use these profiles when the local Xcode is older than 26.4 or before device signing is complete:

```bash
pnpm eas:ios:dev:simulator
pnpm eas:ios:preview:simulator
pnpm exec eas build:run --platform ios
```

The development simulator build uses Metro; the preview simulator build contains its JavaScript
bundle. Simulator artifacts cannot be installed on a physical iPhone or submitted to TestFlight.
They require an Apple silicon Mac because the vendored terminal library has no Intel simulator slice.
EAS build commands may consume the account's build quota.

Android internal builds produce APKs:

```bash
pnpm eas:android:dev
pnpm eas:android:preview
```

## Next milestones

1. **Source updates:** keep the pinned upstream import and fork runtime together; rerun the
   compatibility and Direct Connect regressions before advancing the pin.
2. **Owned device distribution:** complete interactive Apple signing/App Store Connect setup,
   install a dev client and a standalone preview, and retain the official app only for comparisons.
3. **Connection acceptance:** pair over Tailscale HTTPS and complete the physical checklist above,
   including cellular access, attachments, suspension, queued sends, restart, and revocation.
4. **Diagnostics and reliability:** collect the new connection report on a signed physical build,
   then fix reproduced mobile quirks rather than guessing at queue/reconnect behavior.
5. **Feature and release ownership:** add the next specified mobile UX, an owned push/Live Activity
   service if needed, then optional owned OTA channels.
   Keep native updates and server-protocol compatibility separate from Expo runtime versions.

## Upstream maintenance and license

Keep upstream changes as reviewed imports with a recorded commit, not automatic directory copies.
Compare `apps/mobile`, its workspace imports, dependency catalogs/patches, and native plugins on
each update. Release the client and server only after their paired behavior is exercised.

The upstream MIT copyright/license is retained in the root `LICENSE`; native module licenses
remain in their respective directories. Keep those notices and review additional dependency and
asset licenses before public distribution. `T3 Code RG` identifies this build as the independent
fork, not the official App Store client.
