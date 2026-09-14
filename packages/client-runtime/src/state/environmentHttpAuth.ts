import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient, type HttpMethod } from "effect/unstable/http";

import type { PreparedHttpAuthorization } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  RemoteEnvironmentAuthFetchError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

export interface EnvironmentHttpAuthHeaders {
  readonly authorization?: string;
  readonly dpop?: string;
}

/**
 * Primary/local environments with no bearer or DPoP credential authenticate the
 * browser via a session cookie. A cross-origin `fetch` does not send cookies by
 * default, so those requests must opt into credentialed mode; bearer/DPoP
 * connections carry their credential in a header and need no cookies. Applied
 * per-request via `FetchHttpClient.RequestInit`, which the fetch client reads
 * from the fiber context at request time.
 */
export const withEnvironmentCredentials = <A, E, R>(
  authorization: PreparedHttpAuthorization | null,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  authorization === null
    ? request.pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }))
    : request;

/**
 * Build the authorization headers for an authenticated environment HTTP
 * request, matching the credential the connection was prepared with:
 * - primary/local connections carry no credential,
 * - bearer connections send a static `Bearer` token,
 * - relay connections send a `DPoP` access token with a freshly signed proof
 *   bound to this request's method and URL.
 *
 * The DPoP signer is passed in (not resolved from context) and is only required
 * for relay/DPoP connections, so bearer/primary connections work even when no
 * signer is available.
 */
export const buildEnvironmentAuthHeaders = (
  authorization: PreparedHttpAuthorization | null,
  method: HttpMethod.HttpMethod,
  url: string,
  signer: Option.Option<ManagedRelayDpopSigner["Service"]>,
): Effect.Effect<EnvironmentHttpAuthHeaders, RemoteEnvironmentAuthFetchError> =>
  Effect.gen(function* () {
    if (authorization === null) {
      return {};
    }
    if (authorization._tag === "Bearer") {
      return { authorization: `Bearer ${authorization.token}` };
    }
    if (Option.isNone(signer)) {
      return yield* new RemoteEnvironmentAuthFetchError({
        message: "No DPoP signer is available to authorize the environment request.",
        cause: authorization._tag,
      });
    }
    const accessToken = authorization.renewAccessToken
      ? yield* authorization.renewAccessToken().pipe(
          Effect.mapError(
            (cause) =>
              new RemoteEnvironmentAuthFetchError({
                message: "Could not renew environment HTTP authorization.",
                cause,
              }),
          ),
        )
      : authorization.accessToken;
    const proof = yield* signer.value.createProof({ method, url, accessToken }).pipe(
      Effect.mapError(
        (cause) =>
          new RemoteEnvironmentAuthFetchError({
            message: "Could not create the environment request authorization proof.",
            cause,
          }),
      ),
    );
    return { authorization: `DPoP ${accessToken}`, dpop: proof };
  });

/** The caller must be a read operation, even when its HTTP method is POST. */
export const requestEnvironmentRead = <A, R>(
  authorization: PreparedHttpAuthorization | null,
  url: string,
  signer: Option.Option<ManagedRelayDpopSigner["Service"]>,
  request: (
    headers: EnvironmentHttpAuthHeaders,
  ) => Effect.Effect<A, RemoteEnvironmentRequestError, R>,
  method: HttpMethod.HttpMethod = "GET",
): Effect.Effect<A, RemoteEnvironmentRequestError, R> =>
  Effect.gen(function* () {
    const headers = yield* buildEnvironmentAuthHeaders(authorization, method, url, signer);
    return yield* withEnvironmentCredentials(authorization, request(headers)).pipe(
      Effect.catch((error) => {
        const renew = authorization?._tag === "Dpop" ? authorization.renewAccessToken : undefined;
        if (
          !renew ||
          !(
            error._tag === "EnvironmentAuthInvalidError" ||
            (error._tag === "RemoteEnvironmentAuthUndeclaredStatusError" && error.status === 401)
          )
        ) {
          return Effect.fail(error);
        }
        return Effect.gen(function* () {
          const rejected = headers.authorization?.slice("DPoP ".length);
          const accessToken = yield* renew(rejected).pipe(
            Effect.mapError(
              (cause) =>
                new RemoteEnvironmentAuthFetchError({
                  message: "Could not renew rejected environment HTTP authorization.",
                  cause,
                }),
            ),
          );
          const retryHeaders = yield* buildEnvironmentAuthHeaders(
            { _tag: "Dpop", accessToken },
            method,
            url,
            signer,
          );
          return yield* request(retryHeaders);
        });
      }),
    );
  });
