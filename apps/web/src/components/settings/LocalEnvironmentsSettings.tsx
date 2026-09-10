import type { DesktopBridge } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

type Inspection = Awaited<ReturnType<NonNullable<DesktopBridge["getLocalEnvironments"]>>>;

export function LocalEnvironmentsSettings() {
  const bridge = window.desktopBridge;
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!bridge?.getLocalEnvironments) return;
    setBusy(true);
    setError(null);
    try {
      setInspection(await bridge.getLocalEnvironments());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not inspect local environments.");
    } finally {
      setBusy(false);
    }
  }, [bridge]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = async (baseDir?: string) => {
    if (!bridge?.selectLocalEnvironment) return;
    setError(null);
    setBusy(true);
    try {
      const selected = baseDir ?? (await bridge.pickFolder());
      if (selected) await bridge.selectLocalEnvironment(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not select the environment.");
    } finally {
      setBusy(false);
    }
  };
  if (!bridge?.getLocalEnvironments) return null;
  return (
    <SettingsSection title="Local environments">
      <p className="text-xs text-muted-foreground">
        A project folder can exist in multiple environments with different threads. Choose one
        default to share between desktop and CLI. Switching does not merge or delete history.
        Development launches and explicit data directories stay isolated.
      </p>
      <div className="flex gap-2 py-2">
        <Button size="sm" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </Button>
        <Button
          size="sm"
          disabled={busy || !inspection?.canChooseDefault}
          onClick={() => void select()}
        >
          Choose existing data directory
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {inspection?.selectionError ? (
        <p role="alert" className="text-xs text-destructive">
          {inspection.selectionError}
        </p>
      ) : null}
      {inspection && !inspection.canChooseDefault ? (
        <p className="text-xs text-muted-foreground">
          This launch is pinned to its data directory. Development apps and explicit T3CODE_HOME
          overrides do not follow the shared default.
        </p>
      ) : null}
      {inspection?.environments.map((environment) => (
        <div key={environment.baseDir} className="space-y-1 border-t py-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <strong>{environment.label}</strong>
            {environment.baseDir === inspection.currentBaseDir ? (
              <span>
                Current ·{" "}
                {inspection.ownership === "desktop"
                  ? "Desktop managed"
                  : "Attached; externally managed"}
              </span>
            ) : (
              <Button
                size="sm"
                disabled={
                  busy || !inspection.canChooseDefault || environment.status === "unavailable"
                }
                onClick={() => void select(environment.baseDir)}
              >
                Use as default
              </Button>
            )}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
            <dt>Environment ID</dt>
            <dd className="break-all font-mono">{environment.environmentId}</dd>
            <dt>Data directory</dt>
            <dd className="break-all">{environment.baseDir}</dd>
            <dt>Status</dt>
            <dd>{environment.status}</dd>
            <dt>Endpoint / PID</dt>
            <dd>
              {environment.origin ?? "Not running"} / {environment.pid ?? "—"}
            </dd>
            <dt>Server build</dt>
            <dd>{environment.serverVersion ?? "Unavailable while offline"}</dd>
          </dl>
          {environment.error ? (
            <p role="alert" className="text-destructive">
              {environment.error}
            </p>
          ) : null}
        </div>
      ))}
    </SettingsSection>
  );
}
