import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  type RelayClientEnvironmentRecord,
  type RelayEnvironmentLinkResponse,
} from "@t3tools/contracts/relay";
import * as ClientCapabilities from "../../../packages/client-runtime/src/platform/capabilities.ts";
import * as Connectivity from "../../../packages/client-runtime/src/connection/connectivity.ts";
import * as ConnectionWakeups from "../../../packages/client-runtime/src/connection/wakeups.ts";
import * as ManagedRelay from "../../../packages/client-runtime/src/relay/managedRelay.ts";
import * as RelayEnvironmentDiscovery from "../../../packages/client-runtime/src/relay/discovery.ts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import { fetchLiveOrchestrationShellSnapshot } from "../src/cli/client.ts";
import * as CliState from "../src/cloud/CliState.ts";
import * as CliTokenManager from "../src/cloud/CliTokenManager.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../src/cloud/config.ts";
import { reconcileDesiredCloudLink } from "../src/cloud/http.ts";
import * as ManagedEndpointRuntime from "../src/cloud/ManagedEndpointRuntime.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";

const RELAY_ORIGIN = "https://release-smoke-relay.invalid";
const environmentId = EnvironmentId.make("release-smoke-environment");
const descriptor = {
  environmentId,
  label: "Release smoke environment",
  platform: {
    os: "darwin",
    arch: "arm64",
  },
  serverVersion: "0.0.0-release-smoke",
  capabilities: {
    repositoryIdentity: false,
  },
} satisfies ExecutionEnvironmentDescriptor;

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
      create: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => {
          const existing = values.get(name);
          if (existing !== undefined) return existing;
          const value = NodeCrypto.randomBytes(bytes);
          values.set(name, value);
          return value;
        }),
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
        }),
      list: () => Effect.succeed([...values.keys()]),
    }),
  };
}

function readSecret(values: ReadonlyMap<string, Uint8Array>, name: string): string {
  const value = values.get(name);
  assert(value !== undefined, `Expected ${name} to be persisted.`);
  return new TextDecoder().decode(value);
}

async function startFakeEnvironmentServer() {
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/orchestration/shell-snapshot") {
      if (request.headers.authorization !== `Bearer ${connect.credential}`) {
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
  if (!address || typeof address === "string") {
    throw new Error("Fake environment server did not bind a TCP port.");
  }
  const endpoint = {
    httpBaseUrl: `http://127.0.0.1:${address.port}`,
    wsBaseUrl: `ws://127.0.0.1:${address.port}`,
    providerKind: "cloudflare_tunnel" as const,
  };
  const link = {
    ok: true,
    cloudUserId: "release-smoke-user",
    environmentId,
    endpoint,
    endpointRuntime: null,
    relayIssuer: RELAY_ORIGIN,
    environmentCredential: "release-smoke-environment-credential",
    cloudMintPublicKey: NodeCrypto.generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString()
      .trim(),
  } satisfies RelayEnvironmentLinkResponse;
  const connect = {
    environmentId,
    endpoint,
    credential: "release-smoke-connect-credential",
    expiresAt: "2026-07-30T01:00:00.000Z",
  };
  return {
    link,
    connect,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function makeFakeRelayHttpClient(link: RelayEnvironmentLinkResponse) {
  return HttpClient.make((request) => {
    const url = new URL(request.url);
    const body =
      url.pathname === "/oauth/token"
        ? {
            access_token: "release-smoke-cli-access",
            refresh_token: "release-smoke-cli-refresh",
            expires_in: 3600,
            token_type: "Bearer",
          }
        : url.origin === RELAY_ORIGIN && url.pathname === "/v1/client/environment-link-challenges"
          ? {
              challenge: "release-smoke-link-challenge",
              expiresAt: "2026-07-30T01:00:00.000Z",
            }
          : url.origin === RELAY_ORIGIN && url.pathname === "/v1/client/environment-links"
            ? link
            : undefined;
    return body === undefined
      ? Effect.die(new Error(`Unexpected release smoke HTTP request: ${request.url}`))
      : Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
  });
}

const fakeEndpointRuntime = ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
  applyConfig: () => Effect.succeed({ status: "disabled" as const }),
  getStatus: Effect.succeed({ status: "disabled" as const }),
});

const fakeEnvironmentAuth = EnvironmentAuth.EnvironmentAuth.of({
  issueSession: () => Effect.die("unused"),
  revokeSession: () => Effect.die("unused"),
  createPairingLink: () => Effect.die("unused"),
});

async function main() {
  const fakeServer = await startFakeEnvironmentServer();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const secrets = memorySecretStore();
          const callbackState = "release-smoke-callback-state";
          const httpClient = makeFakeRelayHttpClient(fakeServer.link);
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
          ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

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

          yield* reconcileDesiredCloudLink(fakeServer.link.endpoint.httpBaseUrl).pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.service),
                Layer.succeed(
                  ServerEnvironment.ServerEnvironment,
                  ServerEnvironment.ServerEnvironment.of({
                    getEnvironmentId: Effect.succeed(environmentId),
                    getDescriptor: Effect.succeed(descriptor),
                  }),
                ),
                Layer.succeed(
                  ManagedEndpointRuntime.CloudManagedEndpointRuntime,
                  fakeEndpointRuntime,
                ),
                Layer.succeed(EnvironmentAuth.EnvironmentAuth, fakeEnvironmentAuth),
                Layer.succeed(CliTokenManager.CloudCliTokenManager, tokens),
                Layer.succeed(HttpClient.HttpClient, httpClient),
                ConfigProvider.layer(
                  ConfigProvider.fromEnv({
                    env: { T3CODE_RELAY_URL: RELAY_ORIGIN },
                  }),
                ),
              ),
            ),
          ) as Effect.Effect<unknown, unknown, never>;

          assert(
            readSecret(secrets.values, RELAY_URL_SECRET) === RELAY_ORIGIN,
            "Reconciliation did not persist the relay URL from the link response.",
          );
          assert(
            readSecret(secrets.values, RELAY_ISSUER_SECRET) === fakeServer.link.relayIssuer,
            "Reconciliation did not persist the relay issuer from the link response.",
          );
          assert(
            readSecret(secrets.values, CLOUD_LINKED_USER_ID) === fakeServer.link.cloudUserId,
            "Reconciliation did not persist the linked cloud user from the link response.",
          );
          assert(
            readSecret(secrets.values, RELAY_ENVIRONMENT_CREDENTIAL_SECRET) ===
              fakeServer.link.environmentCredential,
            "Reconciliation did not persist the environment credential from the link response.",
          );
          assert(
            readSecret(secrets.values, CLOUD_MINT_PUBLIC_KEY) ===
              fakeServer.link.cloudMintPublicKey,
            "Reconciliation did not persist the mint key from the link response.",
          );

          const environment: RelayClientEnvironmentRecord = {
            environmentId: fakeServer.link.environmentId,
            label: descriptor.label,
            endpoint: fakeServer.link.endpoint,
            linkedAt: "2026-07-30T00:00:00.000Z",
          };
          const relay = ManagedRelay.ManagedRelayClient.of({
            relayUrl: readSecret(secrets.values, RELAY_URL_SECRET),
            listEnvironments: () =>
              Effect.sync(() => {
                assert(
                  readSecret(secrets.values, RELAY_ENVIRONMENT_CREDENTIAL_SECRET) ===
                    fakeServer.link.environmentCredential,
                  "Relay environment was served before the reconciled credential was persisted.",
                );
                return [environment];
              }),
            getEnvironmentStatus: ({ environmentId: requestedEnvironmentId }) =>
              Effect.sync(() => {
                assert(
                  requestedEnvironmentId === environment.environmentId,
                  "Discovery requested status for an unexpected environment.",
                );
                return {
                  environmentId: environment.environmentId,
                  endpoint: environment.endpoint,
                  status: "online" as const,
                  checkedAt: "2026-07-30T00:00:00.000Z",
                };
              }),
            listDevices: () => Effect.die("unused"),
            createEnvironmentLinkChallenge: () => Effect.die("unused"),
            linkEnvironment: () => Effect.die("unused"),
            unlinkEnvironment: () => Effect.die("unused"),
            connectEnvironment: ({ environmentId: requestedEnvironmentId }) =>
              Effect.sync(() => {
                assert(
                  requestedEnvironmentId === environment.environmentId,
                  "Connect requested an environment that was not discovered.",
                );
                return fakeServer.connect;
              }),
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
            "Relay discovery did not consume the reconciled environment endpoint.",
          );

          const connected = yield* relay.connectEnvironment({
            clerkToken: "release-smoke-clerk-token",
            scopes: [RelayEnvironmentConnectScope, RelayEnvironmentStatusScope],
            environmentId: discovered.environment.environmentId,
          });
          assert(
            connected.endpoint.httpBaseUrl === discovered.environment.endpoint.httpBaseUrl,
            "Relay connect returned an endpoint other than the discovered environment.",
          );
          const snapshot = yield* fetchLiveOrchestrationShellSnapshot(
            discovered.environment.endpoint.httpBaseUrl,
            connected.credential,
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
