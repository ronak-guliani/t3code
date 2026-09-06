import { ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";

type FeedbackSettings = Pick<ServerSettings, "providerInstances" | "copilotAutomaticPrFeedback">;

export function automaticPrFeedbackBlockReason(
  settings: FeedbackSettings,
  targetInstanceId: ProviderInstanceId,
  existingSession?: {
    readonly providerName: string | null;
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly status: string;
  } | null,
): string | null {
  const isCopilot = (driver: string | null) =>
    driver === "copilot" || driver === "copilot-acp-native";
  const existingDriver =
    existingSession?.providerName ??
    (existingSession?.providerInstanceId
      ? (settings.providerInstances[existingSession.providerInstanceId]?.driver ??
        existingSession.providerInstanceId)
      : null);
  const existingInstanceId =
    existingSession?.providerInstanceId ??
    (isCopilot(existingDriver) && existingDriver
      ? ProviderInstanceId.make(existingDriver)
      : undefined);
  if (
    existingSession &&
    existingSession.status !== "stopped" &&
    isCopilot(existingDriver) &&
    (existingInstanceId === undefined ||
      settings.copilotAutomaticPrFeedback[existingInstanceId] !== true)
  ) {
    return "Automatic PR feedback is pending to protect existing Copilot work. Enable automatic PR feedback for that session's provider in Settings to resume.";
  }
  const targetDriver = settings.providerInstances[targetInstanceId]?.driver ?? targetInstanceId;
  if (isCopilot(targetDriver) && settings.copilotAutomaticPrFeedback[targetInstanceId] !== true) {
    return "Automatic PR feedback is pending. Enable automatic PR feedback for the selected Copilot provider in Settings to resume.";
  }
  return null;
}
