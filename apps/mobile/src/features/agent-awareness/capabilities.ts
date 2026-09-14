import Constants from "expo-constants";

function supportsAgentAwarenessRemoteCapability(enabled: unknown) {
  return enabled !== false && Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true;
}

export function supportsAgentAwarenessPush() {
  return supportsAgentAwarenessRemoteCapability(
    Constants.expoConfig?.extra?.agentAwarenessPushEnabled,
  );
}

export function supportsAgentAwarenessLiveActivities() {
  return supportsAgentAwarenessRemoteCapability(
    Constants.expoConfig?.extra?.agentAwarenessLiveActivitiesEnabled,
  );
}
