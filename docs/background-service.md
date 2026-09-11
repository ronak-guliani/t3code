# Background service

## Install or update the CLI from this fork

Pulling source changes does not rebuild an existing `t3` executable. If another Mac still prints
`Start T3 to provision this environment.` after accepting background setup, update its CLI rather
than repeatedly running the old installer. From an up-to-date checkout with dependencies installed:

```sh
pnpm install:t3:cli --connect
```

This builds the web assets and CLI with the public Connect configuration, installs a self-contained
runtime under `~/.local/share/t3`, updates the existing user-owned `t3` symlink on PATH, and runs
Connect setup using that exact new binary. It waits for relay readiness and fails explicitly
if setup does not come online instead of treating account authorization as a working connection.
It does not modify the desktop app, delete old CLI
installations, or migrate account data. With no existing CLI, a user-owned bin directory must be
on PATH. Regular executable files and system-owned installations are not overwritten.

Use `--base-dir /path/to/existing/home` when the host uses a custom data directory. Stop a
foreground T3 server using that directory before setup. Complete browser sign-in and the
background-service prompt when shown. Without `--connect`, the command only updates the CLI.
Re-run it after pulling future CLI fixes; merging or updating source alone does not update
installed binaries.

`t3 service install` installs the exact packaged CLI and its installed production dependencies as a per-user service and starts it immediately. The private snapshot includes native assets, does not depend on the original checkout's `node_modules`, and is checked before replacing a working service. Re-running install repairs the definition and replaces the runtime, so run it again from the newly installed packaged CLI after an upgrade.

For T3 Connect, start with `t3 connect`: sign in and accept the background-service prompt. You do
not need to start `t3 serve` first or configure a domain, VPN, or a second connector. Once
`t3 connect status` says **linked and online**, sign into the same account on each client and
select the host in its T3 Connect environments.

If a foreground server already uses the intended base directory, stop it before installing.
The installer reports its PID rather than silently running two servers against the same data.
Keep `--base-dir` consistent across `connect`, `service`, and `serve` commands; account
authorization and paired-device data remain there. New services bind to loopback by default.

```sh
t3 service install --base-dir ~/.t3 --cwd ~/code --host 127.0.0.1 --port 13773
t3 service status
t3 service disable
t3 service enable
t3 service restart
t3 service stop
t3 service start
t3 service uninstall
```

On macOS this creates a per-base-directory LaunchAgent. It starts when that user's GUI session logs in, survives terminal logout, restarts after crashes, and returns after reboot only after the user logs in. macOS may require approval in **System Settings > General > Login Items & Extensions**.

Linux and Windows are currently reported as unsupported and no supervisor state is changed. Linux support is intentionally deferred until systemd user-manager and linger behavior can be production-tested across supported distributions.

The instance-specific definition path and rotating server log are shown by `t3 service status`. The log is the normal bounded `userdata/logs/server.log`; launchd stdout and stderr are discarded instead of appending a second unbounded log. Each service instance writes health discovery state inside its private runtime directory, so a foreground server using the same base directory cannot satisfy or lose the service health record. Status reports launchd loaded state, process state/PID, and HTTP responsiveness rather than treating a definition file as proof of availability. Uninstall stops and disables that base-directory instance and removes only that instance's definition and runtime artifacts.

Startup waits for launchd to publish a running PID before checking that PID's HTTP endpoint.
Restart waits for the previous job to unload before bootstrapping its replacement; it does not
kill the process that `RunAtLoad` has just started. A failed candidate restores the previous
service when shutdown succeeds. If launchd cannot confirm shutdown, the installer reports that
failure and retains the runtime rather than deleting files a process might still be using.

### Multiple desktop and CLI environments

Threads belong to a server environment, not the phone, browser, or desktop viewing it.
Identical project names or folders on two environments do not imply shared history.

Use this fork's executable (not an unrelated `npx t3` installation) to inspect and choose:

```sh
t3 local list
t3 local select --base-dir /absolute/path/to/existing/.t3-rg
```

The explicit selection is stored in `~/.config/t3/local-environment.json` with the environment
ID. Ordinary CLI defaults and the regular desktop application follow it on their next launch.
`--base-dir`, `T3CODE_HOME`, injected agent targets, and development desktop launches retain
their explicit isolation. A missing or changed selected identity fails rather than opening
another environment. Existing legacy `~/.t3` defaults remain valid; when it is absent but a
known non-development home exists, the CLI asks you to select one instead of silently creating
another. Discovery checks known home directories, not your entire filesystem.
If the saved selection is broken, `t3 local list` still prints healthy candidates and warns on
stderr; the desktop inspector shows the same warning without disabling explicit selection.
Startup remains blocked until you repair the selection; discovery never changes the default.

On first regular desktop launch, choose an existing **stopped** environment or explicitly keep
a separate desktop environment. Desktop starts its bundled backend in the selected directory.
If another server is running there, desktop refuses to start: it neither mints a pairing
credential nor loads that server's pages into its privileged renderer.

**Automatic attachment is disabled for security.** Matching public environment IDs, live PIDs,
and file ownership do not authenticate the HTTP listener. Safe automatic attachment requires
an authenticated transport that remains bound to the intended server instance.

To keep a CLI/service environment running, launch desktop with a separate `T3CODE_HOME`, then
add the running environment through **Settings > Connections** using explicit pairing or
Connect. The existing host is an API connection, not the source of the privileged desktop
application. Alternatively, stop the CLI/service first and let desktop own that environment.
Selection never stops another process or silently falls back to a different directory.

Every server launcher acquires a lifetime startup claim before services, migrations, or HTTP
startup, then rechecks persisted runtime ownership. The claim uses a dedicated
`server-startup.sqlite` file in the selected state directory; never delete it to bypass a
running server. A losing launcher exits without starting another backend, and process exit
releases the claim. Keep environment state on a local filesystem with working SQLite locks.

**Settings > Connections > Local environments** shows identity, data directory, process,
endpoint, build, and whether desktop owns the backend. Selection requires native confirmation
and restarts desktop; finish active desktop work first. Dev builds and explicit home overrides
show their pinned state and cannot silently change their own target through this picker.

Thread headers, sidebar rows, search results, and the composer identify their execution host.
The **Other environments** hint offers loaded threads from same-named projects on other hosts;
it is a possible-mismatch hint, not proof that two repositories are identical. Connect or add
an environment before expecting its threads to be visible.

#### Safe consolidation and recovery

Choose one environment as the default and retain the others as explicit connections for their
history. Selection never merges databases, moves project checkouts, deletes old environments,
or replays provider sessions. Before retiring an unused environment, stop it and make a backup:

```sh
t3 local backup --base-dir /absolute/path/to/home --output /private/backups/t3-before-consolidation
```

The output must be a new directory outside the source. A completed backup has a versioned
manifest with per-file SHA-256 hashes. Running/unverifiable environments, changed source files,
symlinks, special files, and existing backup destinations are refused. An incomplete backup is
retained for diagnosis without a usable manifest; the original is never modified.

Backups include private history **and credentials**. Store them privately, restrict Windows
folder permissions to your user, and never upload or commit them. This is a full data-directory
backup, not a portable history interchange format; external project checkouts and OS keychain
entries are not included.

Recovery is intentionally limited to the original, absent directory. Stop all writers,
preserve the old directory separately, then run:

```sh
t3 local restore --archive /private/backups/t3-before-consolidation --base-dir /original/absolute/path/to/home --confirm
```

Recovery verifies the manifest and identity, stages files before publishing, and discards stale
runtime PID information. It refuses existing destinations, portable identity clones, and merges.
Keep preserved copies stopped. Do not run two copies of the same environment identity.
Moving individual threads between existing environments is not supported by this workflow;
keep both connected or use the existing Markdown thread export for a reference copy.

Each environment must keep its own data directory. Do not start a foreground `t3` against a
directory already served in the background. Connect targets the server's actual listening
address family and port rather than `localhost`, so a separate IPv6 server cannot intercept
a desktop environment's IPv4 tunnel. Desktop and CLI builds both need this startup fix;
updating only the CLI does not update an already running desktop application's tunnel.

Connect link proofs require a loopback origin. Explicit interface binds such as
`--host 192.168.1.20` are not supported for Connect; startup reports this limitation.
Use `--host 127.0.0.1` or `--host ::1` for local-only access, or a wildcard bind
(`--host 0.0.0.0` or `--host ::`) when LAN access is also required. Wildcard binds
expose the listener to other interfaces; Connect still targets matching-family loopback.

If mobile reports `endpoint_request_failed`, a running connector alone does not prove that the
endpoint is healthy. Compare `/.well-known/t3/environment` on the host and its public endpoint:
the `environmentId` must match. Do not delete mobile environments to repair host routing;
removal clears local drafts and queued work.

## Owned Remote Access (no phone VPN)

Use a permanent Cloudflare Tunnel to connect phones, tablets, and browsers over ordinary
Wi-Fi or cellular. Each T3 environment has its own hostname, tunnel, and persisted identity.
Multiple clients can pair with one environment; each client can also save multiple environments.
No T3 Connect account, Clerk configuration, or phone-side connector is needed.

### One-time setup on each host

1. Use this fork's packaged CLI with a fixed port and background service. Keep the existing
   fork's base directory if you want its current environment identity and sessions. Never run
   two servers against that directory. The example below uses a separate fork-owned directory,
   not the official app's `~/.t3`:

   ```sh
   t3 service install --base-dir ~/.t3-rg --host 127.0.0.1 --port 13773
   ```

2. In your own Cloudflare account, create a **named, remotely managed tunnel** and a public
   hostname such as `mac.example.com` on a domain you control. Point its HTTP service to
   `http://127.0.0.1:13773` (use the actual fixed T3 port). Leave the HTTP Host header override
   unset so the public host is preserved. Do not use a temporary `trycloudflare.com` URL.
   Do not also run the dashboard's connector installation command: T3 owns this connector.

3. Require HTTPS for that hostname, enable WebSockets, and configure a cache bypass for the
   entire T3 hostname. Do not place an interactive Cloudflare Access login in front of the API:
   native clients use T3's pairing/session authentication, not a Cloudflare browser login.
   Cloudflare is a trusted transport intermediary; this is not end-to-end encryption that
   hides application content from Cloudflare.

4. Run the guided setup on the host:

   ```sh
   t3 remote setup --base-dir ~/.t3-rg
   t3 remote status --base-dir ~/.t3-rg
   ```

   Enter the HTTPS origin and **only the tunnel token** at the hidden prompt, not an install
   command. No Cloudflare account-wide API key is required. Credentials stay in the host's
   restricted secret store, not shell arguments, client configuration, or status output.
   T3 installs its pinned connector if needed and restores it on subsequent server starts.
   Status refreshes approximately every ten seconds; readiness requires an HTTPS probe to
   resolve to this exact environment, not merely a running connector process.

5. Once ready, create a fresh one-time pairing link for each client:

   ```sh
   t3 pair --remote --base-dir ~/.t3-rg
   ```

   Alternatively, use **Settings > Connections > Remote Access > Pair remote device** in
   an owner session. Scan in the mobile app or open the link in a browser. Keep pairing
   links private. Each client receives its own revocable session; do not share one link
   between devices. Repeat host setup and client pairing for a second computer.

For an existing LAN/Tailscale registration, pair again through the new HTTPS address.
The shared connection catalog identifies the environment by ID, not its hostname.
Do not delete the environment first: deletion intentionally clears its local drafts/outbox.
Do not copy credentials to a different host or change environment IDs to make them match.

### Recovery and control

```sh
t3 remote disable --base-dir ~/.t3-rg
t3 remote enable --base-dir ~/.t3-rg
t3 remote status --base-dir ~/.t3-rg
t3 service status --base-dir ~/.t3-rg
```

Disable persists before stopping the connector, so restarting T3 cannot silently re-enable it.
It leaves the Cloudflare tunnel/DNS and paired sessions intact. Revoke individual clients from
**Authorized clients** in Connections or the existing `t3 auth session` commands.
To rotate a tunnel token or change hostname, rerun setup. Never reuse one tunnel for different
independent T3 environments: Cloudflare can distribute requests across its connectors.

The connector handles temporary network loss; T3 bounds process-crash retries and periodically
rechecks endpoint health. Client reconnection continues to use existing resnapshot, draft, and
outbox behavior. A hostname mismatch blocks new pairing. If credentials cannot be read, T3
stops its connector instead of continuing with unknown configuration.

Your host must remain awake and online. The macOS service starts after user login, not before
login following a reboot. Linux/Windows automatic service installation is not supported yet.
Use a packaged server for persistent/public access, not a Vite development server.
Remote Access does not enable OTA updates, push notifications, or automatic account discovery.

### Release acceptance

Before relying on a deployment, check two independently paired clients and two independent
hosts; cellular/Wi-Fi changes; sleep/wake; server/connector restart; interrupted streams and
queued sends; and revocation of one client while another remains connected. Test attachment
uploads against the configured Cloudflare plan's request limits. Check that unauthenticated
HTTP/RPC and WebSocket requests are rejected and that no credentials appear in caches or logs.
Automated local coverage is not evidence of a real Cloudflare or physical-phone connection.

### Deferred

- TODO: account sign-in and automatic environment discovery, reusing upstream Connect contracts.
- TODO: managed account-level provisioning if manual tunnel setup becomes a recurring burden.

## T3 Connect and direct Tailscale HTTPS

Connect onboarding offers background installation after linking. A service failure does not undo the successful link. The service itself does not require Clerk or a relay.

For direct Tailnet access, bind T3 to a fixed loopback port, then let `t3 pair` provision and validate the persistent HTTPS mapping:

```sh
t3 service install --host 127.0.0.1 --port 13773
t3 pair --base-dir ~/.t3 --tailscale --label "Mobile device"
tailscale serve status
```

Scan the printed QR code in the RN app or open the same canonical URL in a browser. Tailscale Serve persists independently across T3 restarts. Use the exact per-port removal command printed by `t3 pair`; avoid `tailscale serve reset`, which removes unrelated mappings too.

The service definition contains its startup paths and selected non-secret configuration. Pairing/session credentials still grant workstation access: use Tailnet ACLs, revoke unused T3 sessions, protect the workstation account, and do not expose the port directly to an untrusted network.
