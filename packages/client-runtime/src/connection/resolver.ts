// @ts-nocheck
import { RelayEnvironmentConnectScope } from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ConnectionPromotion from "./promotion.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  credentialMissingError,
  environmentMismatchError,
  mapManagedRelayError,
  profileMissingError,
} from "./errors.ts";
import type {
  BearerConnectionTarget,
  ConnectionTarget,
  PreparedConnection,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/connection/resolver/ConnectionResolver") {}

const isBearerProfile = Schema.is(BearerConnectionProfile);
const isSshProfile = Schema.is(SshConnectionProfile);
const isBearerCredential = Schema.is(BearerConnectionCredential);

function primarySocketUrl(target: PrimaryConnectionTarget): string {
  const url = new URL(target.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  return url.toString();
}

const makePrimaryBroker = Effect.fn("clientRuntime.connection.broker.makePrimary")(function* () {
  const auth = yield* ClientCapabilities.PrimaryEnvironmentAuth;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.primary")(function* (
    target: PrimaryConnectionTarget,
  ) {
    const bearerToken = yield* auth.bearerToken;
    if (Option.isNone(bearerToken)) {
      return {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: primarySocketUrl(target),
        httpAuthorization: null,
        target,
      } satisfies PreparedConnection;
    }

    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      bearerToken: bearerToken.value,
    });
    return {
      ...authorized,
      target,
    } satisfies PreparedConnection;
  });
});

const makeBearerBroker = Effect.fn("clientRuntime.connection.broker.makeBearer")(function* () {
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.bearer")(function* (
    entry: ConnectionCatalogEntry & { readonly target: BearerConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Option.match(entry.profile, {
      onNone: () => Effect.fail(profileMissingError(target.connectionId)),
      onSome: Effect.succeed,
    });
    if (!isBearerProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not a bearer connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    const credential = yield* credentials.get(target.connectionId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(credentialMissingError(target.connectionId)),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (!isBearerCredential(credential)) {
      return yield* credentialMissingError(target.connectionId);
    }
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: profile.httpBaseUrl,
      wsBaseUrl: profile.wsBaseUrl,
      bearerToken: credential.token,
    });
    return {
      environmentId: authorized.environmentId,
      label: authorized.label,
      httpBaseUrl: authorized.httpBaseUrl,
      socketUrl: authorized.socketUrl,
      httpAuthorization: authorized.httpAuthorization,
      target,
    } satisfies PreparedConnection;
  });
});

const makeRelayBroker = Effect.fn("clientRuntime.connection.broker.makeRelay")(function* () {
  const relay = yield* ManagedRelay.ManagedRelayClient;
  const session = yield* ClientCapabilities.CloudSession;
  const identity = yield* ClientCapabilities.RelayDeviceIdentity;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  const promotion = yield* Effect.serviceOption(ConnectionPromotion.ConnectionPromotion);

  const authorizeViaRelay = Effect.fnUntraced(function* (target: RelayConnectionTarget) {
    return yield* remote.authorizeDpop({
      expectedEnvironmentId: target.environmentId,
      relayUrl: relay.relayUrl,
      obtainBootstrap: Effect.gen(function* () {
        const clerkToken = yield* session.clerkToken.pipe(
          Effect.withSpan("relay.connection.cloudSessionToken.resolve"),
        );
        const deviceId = yield* identity.deviceId.pipe(
          Effect.withSpan("relay.connection.deviceIdentity.resolve"),
        );
        const connected = yield* relay
          .connectEnvironment({
            clerkToken,
            scopes: [RelayEnvironmentConnectScope],
            environmentId: target.environmentId,
            ...(Option.isSome(deviceId) ? { deviceId: deviceId.value } : {}),
          })
          .pipe(Effect.mapError(mapManagedRelayError));
        if (connected.environmentId !== target.environmentId) {
          return yield* environmentMismatchError({
            expected: target.environmentId,
            actual: connected.environmentId,
          });
        }
        return connected;
      }).pipe(Effect.withSpan("relay.connection.bootstrap.obtain")),
    });
  });

  return Effect.fnUntraced(
    function* (target: RelayConnectionTarget) {
      const override = Option.isSome(promotion)
        ? yield* promotion.value.overrideFor(target.environmentId)
        : Option.none();
      let authorized: RemoteEnvironmentAuthorization.AuthorizedRemoteEnvironment | null = null;
      if (Option.isSome(override)) {
        const direct = yield* remote
          .authorizeDpopDirect({
            expectedEnvironmentId: target.environmentId,
            endpoint: {
              ...override.value,
              relayUrl: relay.relayUrl,
            },
            obtainBootstrap: Effect.gen(function* () {
              const clerkToken = yield* session.clerkToken;
              const deviceId = yield* identity.deviceId;
              const connected = yield* relay
                .connectEnvironment({
                  clerkToken,
                  scopes: [RelayEnvironmentConnectScope],
                  environmentId: target.environmentId,
                  ...(Option.isSome(deviceId) ? { deviceId: deviceId.value } : {}),
                })
                .pipe(Effect.mapError(mapManagedRelayError));
              if (connected.environmentId !== target.environmentId) {
                return yield* environmentMismatchError({
                  expected: target.environmentId,
                  actual: connected.environmentId,
                });
              }
              return connected;
            }),
          })
          .pipe(
            Effect.catchTag("ConnectionTransientError", (error) =>
              (Option.isSome(promotion)
                ? promotion.value.reportOverrideFailed(target.environmentId)
                : Effect.void
              ).pipe(
                Effect.andThen(
                  Effect.logDebug("Direct route attempt failed; using the relay.", {
                    environmentId: target.environmentId,
                    reason: error.reason,
                  }),
                ),
                Effect.as(null),
              ),
            ),
            Effect.catchTag("ConnectionBlockedError", (error) =>
              error.reason === "unsupported"
                ? (Option.isSome(promotion)
                    ? promotion.value.reportOverrideFailed(target.environmentId)
                    : Effect.void
                  ).pipe(
                    Effect.andThen(
                      Effect.logDebug("Direct route is incompatible; using the relay.", {
                        environmentId: target.environmentId,
                        reason: error.reason,
                      }),
                    ),
                    Effect.as(null),
                  )
                : Effect.fail(error),
            ),
          );
        authorized = direct;
      }
      authorized ??= yield* authorizeViaRelay(target);
      return {
        environmentId: authorized.environmentId,
        label: authorized.label,
        httpBaseUrl: authorized.httpBaseUrl,
        socketUrl: authorized.socketUrl,
        httpAuthorization: authorized.httpAuthorization,
        routeKind:
          Option.isSome(override) && authorized.httpBaseUrl === override.value.httpBaseUrl
            ? override.value.kind
            : "relay",
        target,
      } satisfies PreparedConnection;
    },
    Effect.withSpan("clientRuntime.connection.broker.relay"),
    withRelayClientTracing,
  );
});

const makeSshBroker = Effect.fn("clientRuntime.connection.broker.makeSsh")(function* () {
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.ssh")(function* (
    entry: ConnectionCatalogEntry & { readonly target: SshConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Option.match(entry.profile, {
      onNone: () => Effect.fail(profileMissingError(target.connectionId)),
      onSome: Effect.succeed,
    });
    if (!isSshProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not an SSH connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    const prepared = yield* ssh.prepare({
      connectionId: target.connectionId,
      expectedEnvironmentId: target.environmentId,
      target: profile.target,
    });
    yield* profiles.put(
      new SshConnectionProfile({
        connectionId: profile.connectionId,
        environmentId: profile.environmentId,
        label: profile.label,
        target: prepared.bootstrap.target,
      }),
    );
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: prepared.bootstrap.httpBaseUrl,
      wsBaseUrl: prepared.bootstrap.wsBaseUrl,
      bearerToken: prepared.bearerToken,
    });
    return {
      environmentId: authorized.environmentId,
      label: authorized.label,
      httpBaseUrl: authorized.httpBaseUrl,
      socketUrl: authorized.socketUrl,
      httpAuthorization: authorized.httpAuthorization,
      target,
    } satisfies PreparedConnection;
  });
});

export const make = Effect.gen(function* () {
  const primary = yield* makePrimaryBroker();
  const bearer = yield* makeBearerBroker();
  const relay = yield* makeRelayBroker();
  const ssh = yield* makeSshBroker();

  const prepare = Effect.fn("clientRuntime.connection.broker.prepare")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const target: ConnectionTarget = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    switch (target._tag) {
      case "PrimaryConnectionTarget":
        return yield* primary(target);
      case "BearerConnectionTarget":
        return yield* bearer({ ...entry, target });
      case "RelayConnectionTarget":
        return yield* relay(target);
      case "SshConnectionTarget":
        return yield* ssh({ ...entry, target });
    }
  });

  return ConnectionResolver.of({ prepare });
});

export const layer = Layer.effect(ConnectionResolver, make);
