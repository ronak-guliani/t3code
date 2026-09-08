import type { EnvironmentMachineKind, ServerConfig } from "@t3tools/contracts";

export function resolveEnvironmentMachineKind(
  config: Pick<ServerConfig, "environment" | "settings"> | null,
): EnvironmentMachineKind {
  return config?.settings.environmentIcon ?? config?.environment.platform.machine ?? "server";
}
