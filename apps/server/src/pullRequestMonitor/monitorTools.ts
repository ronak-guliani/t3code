import type { ProviderDriverKind, ProviderInstanceConfigMap } from "@t3tools/contracts";

/**
 * Monitor tools published on the authenticated `t3-code` MCP surface. Server-derived
 * thread identity comes from the per-session credential, never from tool arguments.
 */
export const PR_MONITOR_MCP_TOOL_NAMES = [
  "pr_monitor_context",
  "pr_monitor_report",
  "pr_monitor_submit_findings",
] as const;

/** Drivers that mount the `t3-code` MCP server into their agent sessions. */
const MCP_CAPABLE_DRIVERS: ReadonlySet<string> = new Set(["copilot", "copilot-acp-native"]);

/**
 * Which monitor tools a thread's agent can actually call. A wake prompt must never point an
 * agent at a tool its session does not mount, so availability follows the thread's provider
 * driver rather than the server's global tool registry.
 */
export function monitorToolNamesForThread(input: {
  readonly instanceId: string | null;
  readonly providerInstances?: ProviderInstanceConfigMap | undefined;
}): ReadonlyArray<string> {
  if (input.instanceId === null) return [];
  const configured = input.providerInstances?.[input.instanceId as keyof ProviderInstanceConfigMap];
  // Built-in defaults use the driver kind as their instance id.
  const driver: ProviderDriverKind | string = configured?.driver ?? input.instanceId;
  return MCP_CAPABLE_DRIVERS.has(driver) ? PR_MONITOR_MCP_TOOL_NAMES : [];
}
