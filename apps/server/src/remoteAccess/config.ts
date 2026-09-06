import { RemoteAccessSetup } from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";
import type { ServerSecretStoreShape } from "../auth/ServerSecretStore.ts";

export const REMOTE_ACCESS_CONFIG = "owned-remote-access";
export const RemoteAccessConfig = Schema.Struct({
  ...RemoteAccessSetup.fields,
  enabled: Schema.Boolean,
});
export type RemoteAccessConfig = typeof RemoteAccessConfig.Type;
const decodeRemoteAccessConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RemoteAccessConfig),
);

export class RemoteAccessError extends Schema.TaggedErrorClass<RemoteAccessError>()(
  "RemoteAccessError",
  { message: Schema.String },
) {}

export function normalizeRemoteAccessUrl(value: string): string {
  const url = new URL(value);
  url.hostname = url.hostname.replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.port ||
    !url.hostname.includes(".") ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local") ||
    url.hostname.endsWith(".trycloudflare.com") ||
    /^[\d.]+$/.test(url.hostname) ||
    url.hostname.includes(":")
  ) {
    throw new Error("Use a permanent public HTTPS hostname without a port, path, or credentials.");
  }
  return url.origin;
}

export const readRemoteAccessConfig = (secrets: ServerSecretStoreShape) =>
  Effect.gen(function* () {
    const value = yield* secrets.get(REMOTE_ACCESS_CONFIG);
    if (Option.isNone(value)) return null;
    const config = yield* decodeRemoteAccessConfig(new TextDecoder().decode(value.value));
    return yield* Effect.try({
      try: () => ({ ...config, publicUrl: normalizeRemoteAccessUrl(config.publicUrl) }),
      catch: () => new RemoteAccessError({ message: "Invalid stored Remote Access hostname." }),
    });
  }).pipe(
    Effect.mapError(
      () =>
        new RemoteAccessError({
          message: "Could not read Remote Access configuration. Repair it with `t3 remote setup`.",
        }),
    ),
  );

export const writeRemoteAccessConfig = (
  secrets: ServerSecretStoreShape,
  config: RemoteAccessConfig,
) =>
  secrets.set(REMOTE_ACCESS_CONFIG, new TextEncoder().encode(JSON.stringify(config))).pipe(
    Effect.mapError(
      () =>
        new RemoteAccessError({
          message: "Could not persist Remote Access configuration.",
        }),
    ),
  );
