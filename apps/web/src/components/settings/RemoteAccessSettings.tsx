import { RemoteAccessPairing, RemoteAccessStatus } from "@t3tools/contracts";
import { buildRemotePairingUrl } from "@t3tools/shared/remote";
import { DateTime, Schema } from "effect";
import { useEffect, useState } from "react";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary";
import { Button } from "../ui/button";
import { MobilePairingDialog } from "./MobilePairingDialog";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import type { MobilePairingDialogState } from "./useMobilePairing";

const decodeStatus = Schema.decodeUnknownSync(RemoteAccessStatus);
const decodePairing = Schema.decodeUnknownSync(RemoteAccessPairing);

async function request(path: string, options?: RequestInit): Promise<unknown> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl(path), {
    credentials: "include",
    cache: "no-store",
    ...options,
  });
  if (!response.ok) {
    const body: unknown = await response.json();
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : `Remote Access request failed (${response.status}).`;
    throw new Error(message);
  }
  return response.json();
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Remote Access request failed.";

export function RemoteAccessSettings() {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<MobilePairingDialogState | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const retryDisable = status?.enabled === false && status.status === "error";
  const nextAction = status?.enabled || retryDisable ? "disable" : "enable";

  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = decodeStatus(
          await request("/api/remote-access", {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          }),
        );
        if (!controller.signal.aborted) {
          setStatus(result);
          setConnectionError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setConnectionError(errorMessage(cause));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 10_000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [busy]);

  const changeEnabled = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(
        decodeStatus(
          await request("/api/remote-access", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: nextAction }),
            signal: AbortSignal.timeout(30_000),
          }),
        ),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const pairDevice = async () => {
    setBusy(true);
    setError(null);
    try {
      const issued = decodePairing(
        await request("/api/remote-access/pair", {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
        }),
      );
      setPairing({
        endpointUrl: issued.publicUrl,
        payload: buildRemotePairingUrl(issued.publicUrl, issued.credential),
        pairingCredential: { ...issued, expiresAt: DateTime.formatIso(issued.expiresAt) },
      });
      setPairingOpen(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Remote Access">
      <SettingsRow
        title="Connect from anywhere"
        description="Use an owned Cloudflare Tunnel. No phone VPN or cloud sign-in required."
        status={
          <div className="space-y-2">
            <p role="status">
              {connectionError
                ? "Connection status unavailable."
                : (status?.message ?? "Loading remote connection status...")}
            </p>
            {status?.publicUrl ? (
              <p className="break-all font-mono text-xs">{status.publicUrl}</p>
            ) : null}
            <p className="text-xs">
              On this host, run <code>t3 remote setup</code> to configure or repair the tunnel. Run{" "}
              <code>t3 service install</code> to keep a packaged server running after terminal
              logout.
            </p>
            <p className="text-xs">
              Pair each device separately. Repeat setup on each host. Disabling disconnects remote
              devices; it does not revoke their sessions.
            </p>
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
            {connectionError ? (
              <p role="alert" className="text-destructive">
                {connectionError}
              </p>
            ) : null}
          </div>
        }
        control={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy || connectionError !== null || status?.status !== "ready"}
              onClick={() => void pairDevice()}
            >
              Pair remote device
            </Button>
            {status?.publicUrl ? (
              <Button variant="outline" disabled={busy} onClick={() => void changeEnabled()}>
                {retryDisable ? "Retry Disable" : status.enabled ? "Disable" : "Enable"}
              </Button>
            ) : null}
          </div>
        }
      />
      <MobilePairingDialog
        state={pairing}
        open={pairingOpen}
        onOpenChange={(open) => {
          setPairingOpen(open);
          if (!open) setPairing(null);
        }}
      />
    </SettingsSection>
  );
}
