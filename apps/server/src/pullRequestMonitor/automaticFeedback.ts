import type { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";

export function allowsAutomaticPrFeedback(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): boolean {
  const instance = settings.providerInstances[instanceId];
  const driver = instance?.driver ?? instanceId;
  if (driver !== "copilot" && driver !== "copilot-acp-native") return true;

  const config = instance ? instance.config : settings.providers.copilot;
  return (
    typeof config === "object" &&
    config !== null &&
    !Array.isArray(config) &&
    "allowAutomaticPrFeedback" in config &&
    config.allowAutomaticPrFeedback === true
  );
}
