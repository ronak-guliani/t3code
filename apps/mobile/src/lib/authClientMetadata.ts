import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import Constants from "expo-constants";
import { Platform } from "react-native";

export function authClientMetadata(): AuthClientPresentationMetadata {
  return {
    label: Constants.expoConfig?.name ?? "T3 Code RG",
    deviceType: "mobile",
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
  };
}
