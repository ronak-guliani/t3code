import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as ClientCapabilities from "../../../packages/client-runtime/src/platform/capabilities.ts";
import * as Connectivity from "../../../packages/client-runtime/src/connection/connectivity.ts";
import * as ConnectionWakeups from "../../../packages/client-runtime/src/connection/wakeups.ts";
import * as ManagedRelay from "../../../packages/client-runtime/src/relay/managedRelay.ts";
import * as RelayEnvironmentDiscovery from "../../../packages/client-runtime/src/relay/discovery.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import { fetchLiveOrchestrationShellSnapshot } from "../src/cli/client.ts";
import * as CliState from "../src/cloud/CliState.ts";
import * as CliTokenManager from "../src/cloud/CliTokenManager.ts";
import { applyCloudRelayConfig } from "../src/cloud/http.ts";
import * as ManagedEndpointRuntime from "../src/cloud/ManagedEndpointRuntime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function memorySecretStore() {
  const values = new Map<string, Uint8Array>();
  return {
    values,
    service: ServerSecretStore.ServerSecretStore.of({
      get: (name) =>
        Effect.sync(() => {
          const value = values.get(name);
          return value === undefined ? Option.none() : Option.some(value);
        }),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
        }),
      list: () => Effect.succeed([...values.keys()]),
    }),
  };
}

async function startFakeRelayAndServer() {
  let expectedBearer = "";
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/v1/release-smoke-link") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/orchestration/shell-snapshot") {
      if (request.headers.authorization !== `Bearer ${expectedBearer}`) {
        response.writeHead(401);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          snapshotSequence: 1,
          projects: [],
          threads: [],
          updatedAt: "2026-07-30T00:00:00.000Z",
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fake relay did not bind a TCP port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    setExpectedBearer: (value: string) => {
      expectedBearer = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const fakeOAuthHttpClient = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json({
        access_token: "release-smoke-cli-access",
        refresh_token: "release-smoke-cli-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    ),
  ),
);

const fakePublicKey = NodeCrypto.generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();

const fakeEndpointRuntime = ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
  applyConfig: () => Effect.succeed({ status: "disabled" as const }),
  getStatus: Effect.succeed({ status: "disabled" as const }),
});

async function main() {
  const fakeServer = await startFakeRelayAndServer();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const secrets = memorySecretStore();
          const callbackState = "release-smoke-callback-state";
          const tokens = yield* CliTokenManager.make.pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.service),
              ),
            ),
          );

          yield* CliTokenManager.withLoopbackAuthorizationCallback(
            {
              redirectUri: "http://127.0.0.1:34338/callback",
              state: callbackState,
            },
            ({ awaitCode }) =>
              Effect.gen(function* () {
                const callback = yield* Effect.promise(() =>
                  fetch(
                    `http://127.0.0.1:34338/callback?code=release-smoke-code&state=${callbackState}`,
                  ),
                );
                assert(callback.status === 200, "Loopback authorization callback was rejected.");
                const exchanged = yield* CliTokenManager.exchangeOAuthToken(
                  {
                    authorizationEndpoint: "https://clerk.invalid/oauth/authorize",
                    tokenEndpoint: "https://clerk.invalid/oauth/token",
                    clientId: "release-smoke-client",
                    redirectUri: "http://127.0.0.1:34338/callback",
                    scopes: ["openid", "profile", "email"],
                  },
                  {
                    grant_type: "authorization_code",
                    code: yield* awaitCode,
                    redirect_uri: "http://127.0.0.1:34338/callback",
                    client_id: "release-smoke-client",
                    code_verifier: "release-smoke-verifier",
                  },
                );
                yield* tokens.store(exchanged.token);
              }),
          ).pipe(Effect.provideService(HttpClient.HttpClient, fakeOAuthHttpClient));

          const persisted = yield* tokens.getExisting;
          const cliToken = Option.getOrThrow(persisted);
          assert(
            cliToken.refreshToken === "release-smoke-cli-refresh",
            "Loopback refresh credential was not persisted.",
          );

          yield* CliState.setCliDesiredCloudLink(true).pipe(
            Effect.provideService(ServerSecretStore.ServerSecretStore, secrets.service),
          );
          assert(
            yield* CliState.readCliDesiredCloudLink.pipe(
              Effect.provideService(ServerSecretStore.ServerSecretStore, secrets.service),
            ),
            "Desired link state was not persisted.",
          );

          const provisionResponse = yield* Effect.promise(() =>
            fetch(`${fakeServer.origin}/v1/release-smoke-link`),
          );
          assert(provisionResponse.status === 200, "Fake relay provisioning response failed.");
          const environment: RelayClientEnvironmentRecord = {
            environmentId: EnvironmentId.make("release-smoke-environment"),
            label: "Release smoke environment",
            endpoint: {
              httpBaseUrl: fakeServer.origin,
              wsBaseUrl: fakeServer.origin.replace(/^http/u, "ws"),
              providerKind: "cloudflare_tunnel",
            },
            linkedAt: "2026-07-30T00:00:00.000Z",
          };
          const environmentAccessToken = "release-smoke-environment-access";
          yield* applyCloudRelayConfig(
            {
              secrets: secrets.service,
              endpointRuntime: fakeEndpointRuntime,
            } as never,
            {
              relayUrl: "https://relay.invalid",
              relayIssuer: "https://relay.invalid",
              cloudUserId: "release-smoke-user",
              environmentCredential: environmentAccessToken,
              cloudMintPublicKey: fakePublicKey,
              endpointRuntime: null,
            },
          ).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secrets.service));
          fakeServer.setExpectedBearer(environmentAccessToken);

          const status = {
            environmentId: environment.environmentId,
            endpoint: environment.endpoint,
            status: "online" as const,
            checkedAt: "2026-07-30T00:00:00.000Z",
          };
          const relay = ManagedRelay.ManagedRelayClient.of({
            relayUrl: "https://relay.invalid",
            listEnvironments: () => Effect.succeed([environment]),
            getEnvironmentStatus: () => Effect.succeed(status),
            listDevices: () => Effect.die("unused"),
            createEnvironmentLinkChallenge: () => Effect.die("unused"),
            linkEnvironment: () => Effect.die("unused"),
            unlinkEnvironment: () => Effect.die("unused"),
            connectEnvironment: () => Effect.die("unused"),
            registerDevice: () => Effect.die("unused"),
            unregisterDevice: () => Effect.die("unused"),
            registerLiveActivity: () => Effect.die("unused"),
            resetTokenCache: Effect.void,
          });
          const network = yield* SubscriptionRef.make<"online">("online");
          const discoveryLayer = RelayEnvironmentDiscovery.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
                Layer.succeed(ClientCapabilities.CloudSession, {
                  clerkToken: Effect.succeed("release-smoke-clerk-token"),
                }),
                Layer.succeed(Connectivity.Connectivity, {
                  status: SubscriptionRef.get(network),
                  changes: SubscriptionRef.changes(network),
                }),
                Layer.succeed(
                  ConnectionWakeups.ConnectionWakeups,
                  ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
                ),
              ),
            ),
          );
          const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery.pipe(
            Effect.provide(discoveryLayer),
          );
          yield* discovery.refresh;
          const discovered = (yield* SubscriptionRef.get(discovery.state)).environments.get(
            environment.environmentId,
          );
          assert(
            discovered?.availability === "online",
            "Relay discovery did not consume provisioned endpoint.",
          );

          const snapshot = yield* fetchLiveOrchestrationShellSnapshot(
            discovered.environment.endpoint.httpBaseUrl,
            environmentAccessToken,
          ).pipe(Effect.provide(FetchHttpClient.layer));
          assert(snapshot.snapshotSequence === 1, "Authenticated shell snapshot was not returned.");
        }),
      ),
    );
    console.log("Composed T3 Connect release smoke passed.");
  } finally {
    await fakeServer.close();
  }
}

await main();
