import type { DesktopBridge } from "@t3tools/contracts";
import { FolderIcon, HardDriveIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "../ui/badge";
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
    <SettingsSection
      title="Local data"
      description="A project folder can exist in multiple environments with different threads. Pick one default to share between desktop and CLI — switching never merges or deletes history."
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-5">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !inspection?.canChooseDefault}
          onClick={() => void select()}
        >
          <FolderIcon aria-hidden className="size-3.5" />
          Choose data directory
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          className="border-t border-border/60 px-4 py-3 text-xs text-destructive sm:px-5"
        >
          {error}
        </p>
      ) : null}
      {inspection?.selectionError ? (
        <p
          role="alert"
          className="border-t border-border/60 px-4 py-3 text-xs text-destructive sm:px-5"
        >
          {inspection.selectionError}
        </p>
      ) : null}
      {inspection && !inspection.canChooseDefault ? (
        <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
          This launch is pinned to its data directory. Development apps and explicit T3CODE_HOME
          overrides do not follow the shared default.
        </p>
      ) : null}
      {inspection?.environments.map((environment) => {
        const isCurrent = environment.baseDir === inspection.currentBaseDir;
        return (
          <div key={environment.baseDir} className="border-t border-border/60 px-4 py-4 sm:px-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground">
                  <HardDriveIcon aria-hidden className="size-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="truncate text-sm font-medium text-foreground">
                      {environment.label}
                    </h3>
                    {isCurrent ? (
                      <Badge variant="outline" size="sm">
                        Current ·{" "}
                        {inspection.ownership === "desktop"
                          ? "Desktop managed"
                          : "Externally managed"}
                      </Badge>
                    ) : (
                      <Badge
                        variant={environment.status === "unavailable" ? "error" : "secondary"}
                        size="sm"
                      >
                        {environment.status}
                      </Badge>
                    )}
                  </div>
                  <p
                    className="truncate font-mono text-[11px] text-muted-foreground/80"
                    title={environment.baseDir}
                  >
                    {environment.baseDir}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground/70">
                    {[
                      environment.origin ?? "Not running",
                      `PID ${environment.pid ?? "—"}`,
                      environment.serverVersion ?? "Build unknown",
                    ].join(" · ")}
                  </p>
                  {environment.error ? (
                    <p role="alert" className="text-xs text-destructive">
                      {environment.error}
                    </p>
                  ) : null}
                </div>
              </div>
              {!isCurrent ? (
                <div className="flex shrink-0 items-center gap-2 pl-11 sm:pl-0">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      busy || !inspection.canChooseDefault || environment.status === "unavailable"
                    }
                    onClick={() => void select(environment.baseDir)}
                  >
                    Use as default
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </SettingsSection>
  );
}
