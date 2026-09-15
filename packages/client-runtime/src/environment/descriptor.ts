import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { environmentEndpointUrl } from "./endpoint.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  makeEnvironmentHttpApiUrlBuilder,
  RemoteEnvironmentAuthInvalidJsonError,
  RemoteEnvironmentAuthUndeclaredStatusError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import type { PreparedHttpAuthorization } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { requestEnvironmentRead } from "../state/environmentHttpAuth.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;
type EnvironmentDescriptor = import("@t3tools/contracts").ExecutionEnvironmentDescriptor;

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/.well-known/t3/environment"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.metadata.descriptor(),
  );
});

export const fetchAuthenticatedRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchAuthenticatedRemoteEnvironmentDescriptor",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly authorization: PreparedHttpAuthorization | null;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = makeEnvironmentHttpApiUrlBuilder(input.httpBaseUrl).metadata.descriptor();
  const httpClient = yield* HttpClient.HttpClient;
  return yield* (
    requestEnvironmentRead(
      input.authorization,
      requestUrl,
      input.signer,
      (
        headers,
      ): Effect.Effect<
        EnvironmentDescriptor,
        RemoteEnvironmentRequestError,
        HttpClient.HttpClient
      > =>
        executeEnvironmentHttpRequest(
          requestUrl,
          input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
          httpClient
            .execute(
              HttpClientRequest.get(requestUrl).pipe(
                HttpClientRequest.acceptJson,
                HttpClientRequest.setHeaders({
                  ...(headers.authorization === undefined
                    ? {}
                    : { authorization: headers.authorization }),
                  ...(headers.dpop === undefined ? {} : { dpop: headers.dpop }),
                }),
              ),
            )
            .pipe(
              Effect.flatMap((response) =>
                Effect.gen(function* () {
                  if (response.status < 200 || response.status >= 300) {
                    return yield* new RemoteEnvironmentAuthUndeclaredStatusError(
                      requestUrl,
                      response.status,
                    );
                  }
                  const body = yield* response.json;
                  return yield* Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor)(body);
                }).pipe(
                  Effect.mapError((cause) =>
                    cause instanceof RemoteEnvironmentAuthUndeclaredStatusError
                      ? cause
                      : new RemoteEnvironmentAuthInvalidJsonError({
                          message: `Remote environment endpoint returned invalid descriptor JSON from ${requestUrl}.`,
                          cause,
                        }),
                  ),
                ),
              ),
            ),
        ),
    ) as Effect.Effect<EnvironmentDescriptor, RemoteEnvironmentRequestError, HttpClient.HttpClient>
  ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
});
