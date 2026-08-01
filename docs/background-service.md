# Background service

`t3 service install` installs the exact packaged CLI that ran the command as a per-user service and starts it immediately. Re-running install repairs the definition and replaces the runtime, so run it again from the newly installed packaged CLI after an upgrade.

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

On macOS this creates a LaunchAgent. It starts at GUI login, survives terminal logout, restarts after crashes, and returns after reboot once that user logs in. macOS may require approval in **System Settings > General > Login Items & Extensions**. On Linux it creates a systemd user unit and enables lingering, so it starts at boot and remains active after logout. Windows is reported as unsupported and no service state is changed.

Logs are shown by `t3 service status` (normally `~/.t3/runtime/background-service/service.log`). Status checks the supervisor, not merely the definition file. Uninstall stops and disables the supervisor before removing its definition.

## T3 Connect and direct Tailscale HTTPS

Connect onboarding offers background installation after linking. A service failure does not undo the successful link. The service itself does not require Clerk or a relay.

For direct Tailnet access, bind T3 to a fixed loopback port and configure Tailscale HTTPS once:

```sh
t3 service install --host 127.0.0.1 --port 13773
tailscale serve --https=443 http://127.0.0.1:13773
```

Pair the RN app/browser with the resulting `https://<machine>.<tailnet>.ts.net` URL. Tailscale Serve configuration persists independently; the T3 service restores the local server after login/boot according to the platform semantics above.

The service definition contains its startup paths and selected non-secret configuration. Pairing/session credentials still grant workstation access: use Tailnet ACLs, revoke unused T3 sessions, protect the workstation account, and do not expose the port directly to an untrusted network.
