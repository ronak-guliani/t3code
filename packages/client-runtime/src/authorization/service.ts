import { EnvironmentId } from "@t3tools/contracts";
import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import {
  exchangeRemoteDpopAccessToken,
  type RemoteEnvironmentAuthError,
  resolveRemoteDpopWebSocketConnectionUrl,
} from "./remote.ts";
import { resolveRemoteWebSocketConnectionUrl } from "../remote.ts";
import { environmentMismatchError, mapRemoteEnvironmentError } from "../connection/errors.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "../connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as TokenStore from "./tokenStore.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/unstable/http/HttpClient";

import type { PreparedHttpAuthorization } from "../connection/model.ts";

export interface RelayEnvironmentAuthorization {
  readonly environmentId: EnvironmentId;
  readonly endpoint: RelayManagedEndpoint;
  readonly credential: string;
}

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpop: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly relayUrl: string;
      readonly obtainBootstrap: Effect.Effect<
        RelayEnvironmentAuthorization,
        ConnectionAttemptError
      >;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;
const CACHED_ENDPOINT_FAILURE_THRESHOLD = 2;

function mapDpopSocketError(error: RemoteEnvironmentAuthError | ConnectionAttemptError) {
  return error._tag === "ConnectionTransientError" || error._tag === "ConnectionBlockedError"
    ? error
    : mapRemoteEnvironmentError(error);
}

const fetchDescriptor = Effect.fn("clientRuntime.connection.remote.fetchDescriptor")(function* (
  httpBaseUrl: string,
) {
  return yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
});

export const make = Effect.gen(function* () {
  const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const tokenStore = yield* TokenStore.RemoteDpopAccessTokenStore;
  const httpClient = yield* HttpClient.HttpClient;
  const cachedEndpointFailures = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const cloudSession = yield* ClientCapabilities.CloudSession;
  const pendingLock = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;
  const tokenLocks = new Map<EnvironmentId, Semaphore.Semaphore>();
  const pendingTokens = new Map<
    EnvironmentId,
    {
      readonly id: object;
      readonly identity: ClientCapabilities.CloudSessionIdentity;
      readonly relayUrl: string;
      readonly result: Effect.Effect<
        { readonly token: TokenStore.RemoteDpopAccessToken; readonly fromCache: boolean },
        ConnectionAttemptError
      >;
    }
  >();
  const authorizationScope = [...presentation.scopes].sort().join(" ");
  const owners = new Map<EnvironmentId, ClientCapabilities.CloudSessionIdentity>();

  const assertAccount = (identity: ClientCapabilities.CloudSessionIdentity) =>
    Effect.gen(function* () {
      const current = yield* cloudSession.identity;
      if (Option.isNone(current) || current.value !== identity) {
        return yield* new ConnectionBlockedError({
          reason: "authentication",
          detail: "Your T3 Connect account changed. Reconnect using the current account.",
        });
      }
    });

  const resetCachedEndpointFailures = (environmentId: string) =>
    Ref.update(cachedEndpointFailures, (current) => {
      if (!current.has(environmentId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });

  const recordCachedEndpointFailure = (environmentId: string) =>
    Ref.modify(cachedEndpointFailures, (current) => {
      const failureCount = (current.get(environmentId) ?? 0) + 1;
      const next = new Map(current);
      next.set(environmentId, failureCount);
      return [failureCount, next] as const;
    });

  const authorizeBearer = Effect.fn("clientRuntime.connection.remote.authorizeBearer")(
    function* (input: {
      readonly expectedEnvironmentId: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeBearer"]
      >[0]["expectedEnvironmentId"];
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
    }) {
      const descriptor = yield* fetchDescriptor(input.httpBaseUrl).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: input.wsBaseUrl,
        httpBaseUrl: input.httpBaseUrl,
        bearerToken: input.bearerToken,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl,
        httpAuthorization: {
          _tag: "Bearer" as const,
          token: input.bearerToken,
        },
      };
    },
  );

  const createDpopSocketUrl = Effect.fn("clientRuntime.connection.remote.createDpopSocketUrl")(
    function* (token: TokenStore.RemoteDpopAccessToken) {
      const ticketProof = yield* signer
        .createProof({
          method: "POST",
          url: environmentEndpointUrl(token.endpoint.httpBaseUrl, "/api/auth/websocket-ticket"),
          accessToken: token.accessToken,
        })
        .pipe(
          Effect.mapError(
            () =>
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "Could not create the websocket authorization proof.",
              }),
          ),
        );
      return yield* resolveRemoteDpopWebSocketConnectionUrl({
        wsBaseUrl: token.endpoint.wsBaseUrl,
        httpBaseUrl: token.endpoint.httpBaseUrl,
        accessToken: token.accessToken,
        dpopProof: ticketProof,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    },
  );

  const authorizeDpopToken = Effect.fn("clientRuntime.connection.remote.authorizeDpopToken")(
    function* (input: {
      readonly expectedEnvironmentId: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeDpop"]
      >[0]["expectedEnvironmentId"];
      readonly obtainBootstrap: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeDpop"]
      >[0]["obtainBootstrap"];
      readonly identity: ClientCapabilities.CloudSessionIdentity;
      readonly relayUrl: string;
      readonly rejectedAccessToken?: string;
    }) {
      yield* assertAccount(input.identity);
      const thumbprint = yield* signer.thumbprint.pipe(
        Effect.mapError(
          () =>
            new ConnectionBlockedError({
              reason: "configuration",
              detail: "Could not load the environment authorization key.",
            }),
        ),
        Effect.withSpan("environment.authorization.dpopKey.resolve"),
      );
      const now = yield* Clock.currentTimeMillis;
      const cached = yield* tokenStore
        .get(input.expectedEnvironmentId)
        .pipe(Effect.withSpan("environment.authorization.accessToken.cache"));
      if (
        Option.isSome(cached) &&
        cached.value.environmentId === input.expectedEnvironmentId &&
        cached.value.accountId === input.identity.accountId &&
        cached.value.authorizationScope === authorizationScope &&
        cached.value.relayUrl === input.relayUrl &&
        cached.value.accessToken !== input.rejectedAccessToken &&
        (!owners.has(input.expectedEnvironmentId) ||
          owners.get(input.expectedEnvironmentId) === input.identity) &&
        cached.value.dpopThumbprint === thumbprint &&
        cached.value.expiresAtEpochMs > now + TOKEN_EXPIRY_SAFETY_MARGIN_MS
      ) {
        yield* Effect.annotateCurrentSpan({
          "connection.remote_token_cache": "hit",
        });
        owners.set(input.expectedEnvironmentId, input.identity);
        return { token: cached.value, fromCache: true };
      }

      yield* resetCachedEndpointFailures(input.expectedEnvironmentId);
      yield* Effect.annotateCurrentSpan({
        "connection.remote_token_cache": "miss",
      });
      const bootstrap = yield* input.obtainBootstrap;
      yield* assertAccount(input.identity);
      if (bootstrap.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: bootstrap.environmentId,
        });
      }
      const descriptor = yield* fetchDescriptor(bootstrap.endpoint.httpBaseUrl).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.withSpan("environment.authorization.descriptor"),
      );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      const bootstrapProof = yield* signer
        .createProof({
          method: "POST",
          url: environmentEndpointUrl(bootstrap.endpoint.httpBaseUrl, "/oauth/token"),
        })
        .pipe(
          Effect.mapError(
            () =>
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "Could not create the environment authorization proof.",
              }),
          ),
        );
      const access = yield* exchangeRemoteDpopAccessToken({
        httpBaseUrl: bootstrap.endpoint.httpBaseUrl,
        credential: bootstrap.credential,
        dpopProof: bootstrapProof,
        scopes: presentation.scopes,
        clientMetadata: presentation.metadata,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.withSpan("environment.authorization.accessToken.exchange"),
      );
      const issuedAt = yield* Clock.currentTimeMillis;
      yield* assertAccount(input.identity);
      const token = new TokenStore.RemoteDpopAccessToken({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        endpoint: bootstrap.endpoint,
        accessToken: access.access_token,
        expiresAtEpochMs: issuedAt + access.expires_in * 1_000,
        dpopThumbprint: thumbprint,
        accountId: input.identity.accountId,
        authorizationScope,
        relayUrl: input.relayUrl,
      });
      yield* tokenStore
        .put(token)
        .pipe(Effect.withSpan("environment.authorization.accessToken.persist"));
      const accountUnchanged = yield* assertAccount(input.identity).pipe(Effect.result);
      if (Result.isFailure(accountUnchanged)) {
        yield* tokenStore.remove(input.expectedEnvironmentId);
        return yield* accountUnchanged.failure;
      }
      owners.set(input.expectedEnvironmentId, input.identity);
      return { token, fromCache: false };
    },
  );

  const authorizeDpop = Effect.fn("clientRuntime.connection.remote.authorizeDpop")(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpop"]>[0],
  ) {
    const account = yield* cloudSession.identity;
    if (Option.isNone(account))
      return yield* new ConnectionBlockedError({
        reason: "authentication",
        detail: "Sign in to T3 Connect to authorize this environment.",
      });
    const identity = account.value;
    const tokenLock = tokenLocks.get(input.expectedEnvironmentId) ?? Semaphore.makeUnsafe(1);
    tokenLocks.set(input.expectedEnvironmentId, tokenLock);
    const getToken = (
      rejectedAccessToken?: string,
      retryJoined = true,
    ): ReturnType<typeof authorizeDpopToken> =>
      Effect.gen(function* () {
        const result = yield* pendingLock.withPermits(1)(
          Effect.gen(function* () {
            yield* assertAccount(identity);
            const pending = pendingTokens.get(input.expectedEnvironmentId);
            if (pending?.identity === identity && pending.relayUrl === input.relayUrl)
              return pending.result;
            const id = {};
            const fiber = yield* authorizeDpopToken({
              ...input,
              identity,
              ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }),
            }).pipe(
              tokenLock.withPermits(1),
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () =>
                  Effect.fail(
                    new ConnectionTransientError({
                      reason: "timeout",
                      detail: "Timed out renewing the environment credential.",
                    }),
                  ),
              }),
              Effect.ensuring(
                Effect.sync(() => {
                  if (pendingTokens.get(input.expectedEnvironmentId)?.id === id)
                    pendingTokens.delete(input.expectedEnvironmentId);
                }),
              ),
              Effect.forkIn(scope),
            );
            const result = Fiber.join(fiber);
            pendingTokens.set(input.expectedEnvironmentId, {
              id,
              identity,
              relayUrl: input.relayUrl,
              result,
            });
            return result;
          }),
        );
        const selected = yield* result;
        if (selected.token.accessToken === rejectedAccessToken) {
          if (retryJoined) return yield* getToken(rejectedAccessToken, false);
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "The environment did not replace the rejected credential. Sign in again.",
          });
        }
        yield* assertAccount(identity);
        return selected;
      });
    let selected = yield* getToken();
    let socket = yield* Effect.gen(function* () {
      if (selected.fromCache) {
        const descriptor = yield* fetchDescriptor(selected.token.endpoint.httpBaseUrl).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
        if (descriptor.environmentId !== input.expectedEnvironmentId)
          return yield* environmentMismatchError({
            expected: input.expectedEnvironmentId,
            actual: descriptor.environmentId,
          });
      }
      yield* assertAccount(identity);
      return yield* createDpopSocketUrl(selected.token);
    }).pipe(Effect.result);
    if (Result.isFailure(socket)) {
      const error = mapDpopSocketError(socket.failure);
      if (!selected.fromCache) {
        yield* tokenLock.withPermits(1)(
          Effect.gen(function* () {
            const stored = yield* tokenStore.get(input.expectedEnvironmentId);
            if (Option.isSome(stored) && stored.value.accessToken === selected.token.accessToken) {
              yield* tokenStore.remove(input.expectedEnvironmentId);
            }
          }),
        );
        return yield* error;
      }
      if (error._tag === "ConnectionTransientError" && selected.fromCache) {
        const failures = yield* recordCachedEndpointFailure(input.expectedEnvironmentId);
        if (failures < CACHED_ENDPOINT_FAILURE_THRESHOLD) return yield* error;
      } else if (error._tag === "ConnectionBlockedError" && error.reason !== "authentication")
        return yield* error;
      selected = yield* getToken(selected.token.accessToken);
      socket = yield* createDpopSocketUrl(selected.token).pipe(Effect.result);
      if (Result.isFailure(socket)) return yield* mapDpopSocketError(socket.failure);
    }
    yield* assertAccount(identity);
    yield* resetCachedEndpointFailures(input.expectedEnvironmentId);
    const token = selected.token;
    return {
      environmentId: token.environmentId,
      label: token.label,
      httpBaseUrl: token.endpoint.httpBaseUrl,
      socketUrl: socket.success,
      httpAuthorization: {
        _tag: "Dpop" as const,
        accessToken: token.accessToken,
        renewAccessToken: (rejectedAccessToken?: string) =>
          getToken(rejectedAccessToken).pipe(
            Effect.flatMap(({ token: renewed }) =>
              renewed.endpoint.httpBaseUrl === token.endpoint.httpBaseUrl
                ? Effect.succeed(renewed.accessToken)
                : Effect.fail(
                    new ConnectionBlockedError({
                      reason: "configuration",
                      detail:
                        "The environment endpoint changed. Reconnect before making HTTP requests.",
                    }),
                  ),
            ),
          ),
      },
    };
  });

  return RemoteEnvironmentAuthorization.of({
    authorizeBearer,
    authorizeDpop: (input) =>
      authorizeDpop(input).pipe(Effect.withSpan("environment.authorization")),
  });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
