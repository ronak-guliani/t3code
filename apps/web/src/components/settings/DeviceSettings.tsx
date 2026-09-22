import { useRef, useState } from "react";
import {
  type EnvironmentId,
  type ServerConfig,
  type SshDeviceHostConfig,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  readEnvironmentConnection,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useServerConfig } from "../../rpc/serverState";
import { useWsConnectionStatus } from "../../rpc/wsConnectionState";
import { deviceEnvironment, useDeviceState } from "../../state/device";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { DeviceHostEditor } from "./DeviceHostEditor";
import { updateDeviceHosts } from "./deviceHostsSettings.logic";
import { useHostConnectionChecks } from "./useHostConnectionChecks";
import { deviceHostConnectionKey } from "./deviceHostConnectionChecks";
import { DeviceHostAvailability } from "../device/DeviceHostAvailability";

interface DeviceEnvironment {
  environmentId: EnvironmentId;
  label: string;
  connected: boolean;
  config: ServerConfig | null;
}

function DeviceHostRows({
  environment,
  busy,
  onEdit,
  onRemove,
}: {
  environment: DeviceEnvironment;
  busy: boolean;
  onEdit: (host: SshDeviceHostConfig) => void;
  onRemove: (host: SshDeviceHostConfig) => void;
}) {
  const { state } = useDeviceState(environment.connected ? environment.environmentId : null);
  const { checks, testConnection } = useHostConnectionChecks([environment]);
  return (
    <div className="space-y-2 py-3">
      <p className="text-xs font-medium">
        {environment.label}
        {environment.connected ? "" : " (disconnected)"}
      </p>
      {environment.config?.settings.deviceHosts.map((host) => {
        const summary = state.hosts.find((item) => item.id === host.id);
        const status = state.hostStatuses[host.id];
        const check = checks[deviceHostConnectionKey(host)]?.[environment.environmentId];
        return (
          <div key={host.id} className="rounded-lg border p-3 text-xs space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">{host.label}</span>{" "}
                <span className="text-muted-foreground">{host.target}</span>
              </div>
              <div className="flex gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || check?.status === "pending"}
                  onClick={() => void testConnection(host)}
                >
                  Test connection
                </Button>
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => onEdit(host)}>
                  Edit
                </Button>
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => onRemove(host)}>
                  Remove
                </Button>
              </div>
            </div>
            {summary ? <DeviceHostAvailability platforms={summary.platforms} /> : null}
            {status ? (
              <p className="text-muted-foreground">{status.detail ?? status.status}</p>
            ) : null}
            {check ? (
              <p
                role="status"
                className={check.status === "failed" ? "text-destructive" : "text-muted-foreground"}
              >
                {check.status === "failed"
                  ? check.error
                  : check.status === "local"
                    ? "Already available locally"
                    : check.status === "pending"
                      ? "Checking connection..."
                      : "Connected"}
              </p>
            ) : null}
          </div>
        );
      })}
      {environment.config?.settings.deviceHosts.length === 0 ? (
        <p className="text-xs text-muted-foreground">No remote device hosts.</p>
      ) : null}
    </div>
  );
}

export function DeviceSettings() {
  const primaryId = usePrimaryEnvironmentId();
  const primaryConfig = useServerConfig();
  const primaryStatus = useWsConnectionStatus();
  const saved = useSavedEnvironmentRegistryStore((state) => state.byId);
  const runtime = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const [selection, setSelection] = useState<string>("primary");
  const [editing, setEditing] = useState<{
    host: SshDeviceHostConfig;
    original?: SshDeviceHostConfig;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const configure = useAtomCommand(deviceEnvironment.configure, { reportFailure: false });
  const environments: DeviceEnvironment[] = [
    ...(primaryId
      ? [
          {
            environmentId: primaryId,
            label: "This environment",
            connected: primaryConfig !== null && primaryStatus.phase === "connected",
            config: primaryConfig,
          },
        ]
      : []),
    ...Object.values(saved)
      .filter((item) => item.environmentId !== primaryId)
      .map((item) => ({
        environmentId: item.environmentId,
        label: item.label,
        connected: runtime[item.environmentId]?.connectionState === "connected",
        config: runtime[item.environmentId]?.serverConfig ?? null,
      })),
  ];
  const targets = environments.filter(
    (item) =>
      selection === "all" ||
      item.environmentId ===
        (selection === "primary" ? (primaryId ?? environments[0]?.environmentId) : selection),
  );
  const ready = targets.length > 0 && targets.every((item) => item.connected && item.config);
  const run = async (action: (target: DeviceEnvironment) => Promise<void>) => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    try {
      const results = await Promise.allSettled(
        targets.map(async (target) => {
          if (!target.connected) throw new Error("Environment disconnected");
          await action(target);
        }),
      );
      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [
              `${targets[index]?.label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
            ]
          : [],
      );
      if (failures.length)
        toastManager.add({
          type: "error",
          title: "Device settings not saved on all environments",
          description: failures.join("\n"),
        });
      return failures.length === 0;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const save = async (host: SshDeviceHostConfig, remove = false, original = host) => {
    const succeeded = await run(async (target) => {
      const connection = readEnvironmentConnection(target.environmentId);
      if (!connection) throw new Error("Environment disconnected");
      const current = await connection.client.server.getConfig();
      await connection.client.server.updateSettings({
        deviceHosts: updateDeviceHosts(current.settings.deviceHosts, host, remove, original),
      });
    });
    if (succeeded) setEditing(null);
  };
  const setEnabled = (enabled: boolean, agent = false) =>
    run(async (target) => {
      const result = await configure({
        environmentId: target.environmentId,
        input: agent
          ? { agentAccessEnabled: enabled }
          : { enabled, ...(enabled ? {} : { agentAccessEnabled: false }) },
      });
      if (result._tag === "Failure") throw new Error("Could not configure device access.");
    });
  return (
    <SettingsSection title="Devices">
      <SettingsRow
        title="Device environments"
        description="Settings and SSH connection tests apply only to the selected environments. SSH keys and aliases are resolved on each environment server."
        control={
          <Select
            value={selection}
            onValueChange={(value) => {
              if (value) {
                setSelection(value);
                setEditing(null);
              }
            }}
            disabled={busy || editing !== null}
          >
            <SelectTrigger aria-label="Device environments">
              <SelectValue>
                {selection === "all" ? "All environments" : (targets[0]?.label ?? "No environment")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="primary">
                {primaryId ? "This environment" : (environments[0]?.label ?? "No environment")}
              </SelectItem>
              {environments
                .filter(
                  (item) => item.environmentId !== (primaryId ?? environments[0]?.environmentId),
                )
                .map((item) => (
                  <SelectItem key={item.environmentId} value={item.environmentId}>
                    {item.label}
                  </SelectItem>
                ))}
              <SelectItem value="all">All environments</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Device support"
        description="Discover and control local and SSH-hosted iOS Simulators and Android Emulators. Enabling support permits installation of pinned Device Hub tools on selected hosts."
        control={
          <Switch
            aria-label="Enable device support"
            disabled={!ready || busy}
            checked={ready && targets.every((item) => item.config?.settings.enableDeviceSupport)}
            onCheckedChange={(checked) => void setEnabled(Boolean(checked))}
          />
        }
      />
      <SettingsRow
        title="Agent device access"
        description="Allow newly started agents to control devices. Separate from manual viewing; restart existing agent sessions after enabling."
        control={
          <Switch
            aria-label="Allow agent device access"
            disabled={
              !ready || busy || targets.some((item) => !item.config?.settings.enableDeviceSupport)
            }
            checked={
              ready && targets.every((item) => item.config?.settings.enableAgentDeviceAccess)
            }
            onCheckedChange={(checked) => void setEnabled(Boolean(checked), true)}
          />
        }
      />
      <SettingsRow
        title="Device hosts"
        description="Remote hosts need key-based SSH access, Node 22+, npm, and simulator or emulator runtimes. Adding a host allows device tool installation when device support is enabled. App delivery and Metro forwarding are not included."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={
              !targets.some((target) => target.connected && target.config) ||
              busy ||
              editing !== null
            }
            onClick={() => setEditing({ host: { id: crypto.randomUUID(), label: "", target: "" } })}
          >
            <PlusIcon className="size-3.5" /> Add host
          </Button>
        }
      >
        {targets.map((target) => (
          <DeviceHostRows
            key={target.environmentId}
            environment={target}
            busy={busy || editing !== null}
            onEdit={(host) => setEditing({ host, original: host })}
            onRemove={(host) => void save(host, true)}
          />
        ))}
        {!targets.length ? (
          <p className="py-3 text-xs text-muted-foreground">
            Connect an environment to manage device hosts.
          </p>
        ) : null}
      </SettingsRow>
      {editing ? (
        <DeviceHostEditor
          host={editing.host}
          isNew={!editing.original}
          targets={targets}
          busy={busy}
          onSave={(host) => void save(host, false, editing.original ?? host)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SettingsSection>
  );
}
