import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AuthPairingCredentialResult } from "./auth.ts";

export const AdvertisedEndpointProviderKind = Schema.Literals([
  "core",
  "private-network",
  "tunnel",
  "manual",
]);
export type AdvertisedEndpointProviderKind = typeof AdvertisedEndpointProviderKind.Type;

export const AdvertisedEndpointReachability = Schema.Literals([
  "loopback",
  "lan",
  "private-network",
  "public",
]);
export type AdvertisedEndpointReachability = typeof AdvertisedEndpointReachability.Type;

export const AdvertisedEndpointHostedHttpsCompatibility = Schema.Literals([
  "compatible",
  "mixed-content-blocked",
  "requires-configuration",
  "unknown",
]);
export type AdvertisedEndpointHostedHttpsCompatibility =
  typeof AdvertisedEndpointHostedHttpsCompatibility.Type;

export const AdvertisedEndpointStatus = Schema.Literals(["available", "unavailable", "unknown"]);
export type AdvertisedEndpointStatus = typeof AdvertisedEndpointStatus.Type;

export const AdvertisedEndpointSource = Schema.Literals([
  "desktop-core",
  "desktop-addon",
  "server",
  "user",
]);
export type AdvertisedEndpointSource = typeof AdvertisedEndpointSource.Type;

export const AdvertisedEndpointProvider = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  kind: AdvertisedEndpointProviderKind,
  isAddon: Schema.Boolean,
});
export type AdvertisedEndpointProvider = typeof AdvertisedEndpointProvider.Type;

export const AdvertisedEndpointCompatibility = Schema.Struct({
  hostedHttpsApp: AdvertisedEndpointHostedHttpsCompatibility,
  desktopApp: Schema.Literals(["compatible", "unknown"]),
});
export type AdvertisedEndpointCompatibility = typeof AdvertisedEndpointCompatibility.Type;

export const AdvertisedEndpoint = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  provider: AdvertisedEndpointProvider,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  reachability: AdvertisedEndpointReachability,
  compatibility: AdvertisedEndpointCompatibility,
  source: AdvertisedEndpointSource,
  status: AdvertisedEndpointStatus,
  isDefault: Schema.optional(Schema.Boolean),
  description: Schema.optional(TrimmedNonEmptyString),
});
export type AdvertisedEndpoint = typeof AdvertisedEndpoint.Type;

export const RemoteAccessSetup = Schema.Struct({
  publicUrl: Schema.String.check(Schema.isMaxLength(2048)),
  connectorToken: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384)),
});
export type RemoteAccessSetup = typeof RemoteAccessSetup.Type;

export const RemoteAccessStatus = Schema.Struct({
  enabled: Schema.Boolean,
  publicUrl: Schema.NullOr(Schema.String),
  status: Schema.Literals(["disabled", "starting", "ready", "unreachable", "error"]),
  message: Schema.String,
  checkedAt: Schema.NullOr(Schema.String),
});
export type RemoteAccessStatus = typeof RemoteAccessStatus.Type;

export const RemoteAccessPairing = Schema.Struct({
  publicUrl: Schema.String,
  ...AuthPairingCredentialResult.fields,
});
export type RemoteAccessPairing = typeof RemoteAccessPairing.Type;
