import { ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import type { ServerConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const OWNED_MOBILE_PROTOCOL_VERSION = 2;

export type MobileCompatibility =
  | { readonly status: "supported"; readonly protocol: "owned-v2" | "legacy-capabilities" }
  | { readonly status: "unsupported"; readonly message: string };

export function mobileCompatibilityForVersion(
  config: Pick<
    ServerConfig,
    "environment" | "shellResumeCompletionMarker" | "threadResumeCompletionMarker"
  >,
  supportedProtocolVersion: number,
): MobileCompatibility {
  const protocolVersion = config.environment.capabilities.ownedMobileProtocolVersion;
  if (protocolVersion !== undefined && protocolVersion !== supportedProtocolVersion) {
    return {
      status: "unsupported",
      message: `This server uses owned mobile protocol ${protocolVersion}; this app supports version ${supportedProtocolVersion}. Install a matching app/server release.`,
    };
  }
  if (
    config.environment.capabilities.connectionProbe !== true ||
    config.shellResumeCompletionMarker !== true ||
    config.threadResumeCompletionMarker !== true
  ) {
    return {
      status: "unsupported",
      message:
        "This server lacks the connection probe or snapshot completion markers required by this app. Update the fork server before reconnecting.",
    };
  }
  return {
    status: "supported",
    protocol: protocolVersion === undefined ? "legacy-capabilities" : "owned-v2",
  };
}

export function mobileCompatibility(
  config: Pick<
    ServerConfig,
    "environment" | "shellResumeCompletionMarker" | "threadResumeCompletionMarker"
  >,
): MobileCompatibility {
  return mobileCompatibilityForVersion(config, OWNED_MOBILE_PROTOCOL_VERSION);
}

export function validateMobileCompatibility(config: ServerConfig) {
  const compatibility = mobileCompatibility(config);
  return compatibility.status === "supported"
    ? Effect.void
    : Effect.fail(
        new ConnectionBlockedError({ reason: "unsupported", detail: compatibility.message }),
      );
}
