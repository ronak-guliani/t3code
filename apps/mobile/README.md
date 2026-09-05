# T3 Code RG Mobile

Our independently configured build of the upstream-derived React Native app. It stays in this
monorepo with the fork server, `packages/contracts`, and `packages/client-runtime`; do not create
a second copy of those packages for mobile.

This first milestone establishes build ownership, not current-upstream feature parity or a
signed device release. It retains the fork-compatible mobile source from fork commit
`262aa38d44130f73e3624b07fd654a4b44330d23` (Expo 56 / React Native 0.85).
Upstream `pingdotgg/t3code` was compared at
`940e8233c227a186044078e99e45e1933eb525e4` on September 5, 2026 UTC
(Expo 57 / React Native 0.86). That revision is an **integration target, not an imported baseline**:
605 mobile files and the shared runtime/contracts differ. Importing only `apps/mobile` would
leave its new protocol calls and dependencies out of sync with this server.

The app uses **Direct Connect** with existing pairing/session authentication, preferably over
Tailscale HTTPS for access across networks. Managed T3 Connect/Clerk, remote APNs/Live Activity
push, telemetry export, and OTA updates are disabled in this build. Desktop production settings
in the root environment cannot enable them. Local widgets/Live Activities remain included.
Configuring an owned Expo project does **not** turn OTA updates back on.

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
Existing fork Dev installations retain their storage; remove obsolete managed-Connect entries
in that app and pair through Direct Connect. The authorized-client list uses the build's display
name, so Dev and Preview sessions are distinguishable.

Use the root-pinned Node/pnpm toolchain and run `pnpm install --frozen-lockfile` at the repository
root. For iOS, install Xcode and CocoaPods; the deployment target is iOS 18. Physical-device
builds need signing under your Apple team, including the widget extension/app group.
Android needs the Android SDK/JDK. Run the commands below from `apps/mobile`.
No Expo account is required for local builds. Unset `APP_VARIANT` selects development;
unknown variants fail rather than silently selecting a release identity.

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

After acceptance, stop the server with `Ctrl-C`, remove the persistent Serve mapping, and revoke the
acceptance session so its bearer credential cannot be reused:

```bash
tailscale serve status
tailscale serve --https=443 off
pnpm --filter t3 start -- auth session list
pnpm --filter t3 start -- auth session revoke <session-id>
pnpm --filter t3 start -- auth pairing list
```

Revoke any still-active pairing credential shown by the final command with
`pnpm --filter t3 start -- auth pairing revoke <pairing-id>`. Do not store the printed pairing URL
or bearer token in shell history, screenshots, logs, or source control.

## EAS Builds

EAS is optional. It requires an Expo account/project you control, your own Apple signing
credentials, and (for TestFlight) your own App Store Connect app record.

1. Create an Expo project named `t3-code-rg` under your account/organization.
2. Put its owner and UUID in **root** `.env.local` (not `apps/mobile/.env.local`):

   ```dotenv
   MOBILE_EAS_OWNER=your-expo-account
   MOBILE_EAS_PROJECT_ID=your-expo-project-uuid
   ```

3. Set the same two public variables in the EAS `development`, `preview`, and `production`
   environments that you will use. They must be available both when evaluating config locally
   and on the builder. Keep signing keys, Apple credentials, and Expo access tokens out of files
   committed to Git.
4. Install/use EAS CLI, authenticate as your own account, then run a build below. Commands fail
   if project ownership is missing, malformed, or points to the inherited upstream project.

Create a cloud dev-client build or an internal standalone preview:

```bash
pnpm eas:ios:dev
pnpm eas:ios:preview
```

For daily use through TestFlight, build the **preview bundle ID** with store distribution:

```bash
pnpm eas:ios:testflight
APP_VARIANT=preview eas submit --platform ios --profile testflight
```

Submission deliberately has no committed Apple app ID. Select your own App Store Connect
record for `com.ronakguliani.t3code.preview` when prompted. Do not choose the upstream app.
Production uses the separate `com.ronakguliani.t3code` record.
TestFlight is a rolling beta distribution path, not a permanent installation.

Android internal builds produce APKs:

```bash
pnpm eas:android:dev
pnpm eas:android:preview
```

## Next milestones

1. **Current-upstream integration:** port the pinned upstream mobile source, native SDK/dependency
   changes, and the contracts/runtime it actually needs together. Preserve fork-only RPCs and
   implement or explicitly gate missing server features; do not replace shared packages wholesale.
2. **Owned device distribution:** configure signing/EAS/App Store Connect, install a dev client
   and a standalone preview, and retain the official app only for comparisons.
3. **Connection acceptance:** pair over Tailscale HTTPS and complete the physical checklist above,
   including cellular access, attachments, suspension, queued sends, restart, and revocation.
4. **Diagnostics and reliability:** correlate client build/device/session, command ID, server
   receipt/acknowledgement, and provider turn without logging credentials or message content.
   Reproduce the reported mobile quirks before changing queue/reconnect behavior.
5. **Feature and release ownership:** add desired mobile UX, explicit supported client/server
   versions, an owned push/Live Activity service if needed, then optional owned OTA channels.
   Keep native updates and server-protocol compatibility separate from Expo runtime versions.

## Upstream maintenance and license

Keep upstream changes as reviewed imports with a recorded commit, not automatic directory copies.
Compare `apps/mobile`, its workspace imports, dependency catalogs/patches, and native plugins on
each update. Release the client and server only after their paired behavior is exercised.

The upstream MIT copyright/license is retained in the root `LICENSE`; native module licenses
remain in their respective directories. Keep those notices and review additional dependency and
asset licenses before public distribution. `T3 Code RG` identifies this build as the independent
fork, not the official App Store client.
