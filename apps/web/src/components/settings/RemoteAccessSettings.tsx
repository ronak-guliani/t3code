import { RemoteAccessPairing, RemoteAccessStatus } from "@t3tools/contracts";
import { buildRemotePairingUrl } from "@t3tools/shared/remote";
import { DateTime, Schema } from "effect";
import { useEffect, useState } from "react";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { MobilePairingDialog } from "./MobilePairingDialog";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import type { MobilePairingDialogState } from "./useMobilePairing";

const decodeStatus = Schema.decodeUnknownSync(RemoteAccessStatus);
const decodePairing = Schema.decodeUnknownSync(RemoteAccessPairing);
const SETUP_COMMAND = "t3 remote setup";

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
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Setup command copied",
        description: "Paste it into a terminal on this host.",
      });
    },
    onError: (cause) => {
      toastManager.add({
        type: "error",
        title: "Could not copy setup command",
        description: cause.message,
      });
    },
  });

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

  const statusTone = connectionError
    ? "error"
    : status?.enabled && status.status === "ready"
      ? "live"
      : status?.enabled
        ? "pending"
        : "muted";
  const statusLabel = connectionError
    ? "Unavailable"
    : status == null
      ? "Loading"
      : status.enabled && status.status === "ready"
        ? "On"
        : status.enabled
          ? "Starting"
          : "Off";
  return (
    <SettingsSection
      title="Remote access"
      description="Reach this machine from anywhere through your own Cloudflare tunnel. No phone VPN or cloud sign-in required."
    >
      <SettingsRow
        title="Remote tunnel"
        description={
          connectionError
            ? "Connection status unavailable."
            : (status?.message ?? "Loading remote connection status…")
        }
        status={
          <div className="space-y-2.5 pt-1">
            <Badge
              variant={
                statusTone === "live"
                  ? "success"
                  : statusTone === "pending"
                    ? "warning"
                    : statusTone === "error"
                      ? "error"
                      : "secondary"
              }
              size="sm"
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  statusTone === "live"
                    ? "bg-success"
                    : statusTone === "pending"
                      ? "bg-warning"
                      : statusTone === "error"
                        ? "bg-destructive"
                        : "bg-muted-foreground/50",
                )}
              />
              {statusLabel}
            </Badge>
            {status?.publicUrl ? (
              <p
                className="truncate font-mono text-[11px] text-muted-foreground/80"
                title={status.publicUrl}
              >
                {status.publicUrl}
              </p>
            ) : null}
            <div className="space-y-1.5">
              <p className="text-[11px] text-muted-foreground/80">
                Run once in a terminal on this host to set up or repair the tunnel:
              </p>
              <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-muted/40 py-1.5 pr-1.5 pl-3">
                <code
                  className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs"
                  translate="no"
                >
                  {SETUP_COMMAND}
                </code>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => copyToClipboard(SETUP_COMMAND, undefined)}
                >
                  {isCopied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              Pair each device separately. Disabling disconnects remote devices without revoking
              their sessions.
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
              variant="default"
              size="sm"
              disabled={busy || connectionError !== null || status?.status !== "ready"}
              onClick={() => void pairDevice()}
              title="Show a pairing code for a remote device"
            >
              Pair remote device
            </Button>
            {status?.publicUrl ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void changeEnabled()}
              >
                {retryDisable ? "Retry disable" : status.enabled ? "Disable" : "Enable"}
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
