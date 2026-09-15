import { execFile } from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeHttps from "node:https";
import { promisify } from "node:util";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthStandardClientScopes,
  EnvironmentId,
  type AdvertisedEndpoint,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import {
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { expect, it } from "vitest";

import * as Authorization from "../../../packages/client-runtime/src/authorization/service.ts";
import * as TokenStore from "../../../packages/client-runtime/src/authorization/tokenStore.ts";
import { RelayConnectionTarget } from "../../../packages/client-runtime/src/connection/model.ts";
import * as Promotion from "../../../packages/client-runtime/src/connection/promotion.ts";
import * as Capabilities from "../../../packages/client-runtime/src/platform/capabilities.ts";
import * as ManagedRelay from "../../../packages/client-runtime/src/relay/managedRelay.ts";
import { buildEnvironmentAuthHeaders } from "../../../packages/client-runtime/src/state/environmentHttpAuth.ts";
import { ServerAuthLive } from "../src/auth/Layers/ServerAuth.ts";
import { ServerSecretStoreLive } from "../src/auth/Layers/ServerSecretStore.ts";
import { ServerAuth } from "../src/auth/Services/ServerAuth.ts";
import {
  authAccessTokenRouteLayer,
  authSessionRouteLayer,
  authWebSocketTicketRouteLayer,
  respondToAuthError,
} from "../src/auth/http.ts";
import { ServerConfig } from "../src/config.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { RemoteAccess } from "../src/remoteAccess/RemoteAccess.ts";
import { ServerAdvertisedEndpoints } from "../src/remoteAccess/ServerAdvertisedEndpoints.ts";
import { routes } from "../src/remoteAccess/http.ts";

const execFileAsync = promisify(execFile);
const environmentId = EnvironmentId.make("routing-integration");
const descriptor: ExecutionEnvironmentDescriptor = {
  environmentId,
  label: "Routing integration host",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: false },
};
const decodePublicJwk = Schema.decodeUnknownSync(
  Schema.Struct({
    kty: Schema.Literal("EC"),
    crv: Schema.Literal("P-256"),
    x: Schema.String,
    y: Schema.String,
  }),
);

function createSigner() {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const publicJwk: DpopPublicJwk = decodePublicJwk(publicKey.export({ format: "jwk" }));
  const thumbprint = computeDpopJwkThumbprint(publicJwk);
  return {
    thumbprint,
    service: ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed(thumbprint),
      createProof: ({ method, url, accessToken }) =>
        Effect.sync(() => {
          const header = Buffer.from(
            JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk }),
          ).toString("base64url");
          const payload = Buffer.from(
            JSON.stringify({
              htm: method,
              htu: url,
              jti: NodeCrypto.randomUUID(),
              iat: Math.floor(Date.now() / 1_000),
              ...(accessToken ? { ath: computeDpopAccessTokenHash(accessToken) } : {}),
            }),
          ).toString("base64url");
          const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
            key: privateKey,
            dsaEncoding: "ieee-p1363",
          }).toString("base64url");
          return `${header}.${payload}.${signature}`;
        }),
    }),
  };
}

// Both routes are local TLS listeners with a test-only trust root, not a real tailnet or relay.
it("discovers and authorizes direct/relay routes over TLS using real DPoP and single-use tickets", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-routing-integration-" });
        const keyPath = path.join(directory, "key.pem");
        const certPath = path.join(directory, "cert.pem");
        const configPath = path.join(directory, "openssl.cnf");
        yield* fs.writeFileString(
          configPath,
          "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Routing integration\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
        );
        yield* Effect.tryPromise(() =>
          execFileAsync(
            "openssl",
            [
              "req",
              "-x509",
              "-newkey",
              "rsa:2048",
              "-nodes",
              "-days",
              "1",
              "-config",
              configPath,
              "-keyout",
              keyPath,
              "-out",
              certPath,
            ],
            { timeout: 10_000 },
          ),
        );
        const key = yield* fs.readFileString(keyPath);
        const cert = yield* fs.readFileString(certPath);
        const signer = createSigner();
        const authContext = yield* Layer.build(
          ServerAuthLive.pipe(
            Layer.provide(SqlitePersistenceMemory),
            Layer.provide(ServerSecretStoreLive),
            Layer.provide(ServerConfig.layerTest(directory, directory)),
          ),
        );
        const auth = Context.get(authContext, ServerAuth);
        let advertised: readonly AdvertisedEndpoint[] = [];
        let discoveryReads = 0;
        const common = Layer.mergeAll(
          Layer.succeed(ServerAuth, auth),
          Layer.succeed(ServerAdvertisedEndpoints, {
            getEndpoints: Effect.sync(() => {
              discoveryReads += 1;
              return advertised;
            }),
          }),
          Layer.mock(RemoteAccess)({}),
          ServerConfig.layerTest(directory, directory),
        );
        const httpRoutes = Layer.mergeAll(
          routes,
          authAccessTokenRouteLayer,
          authSessionRouteLayer,
          authWebSocketTicketRouteLayer,
          HttpRouter.add(
            "GET",
            "/.well-known/t3/environment",
            HttpServerResponse.jsonUnsafe(descriptor),
          ),
          HttpRouter.add(
            "GET",
            "/ws",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const serverAuth = yield* ServerAuth;
              yield* serverAuth.authenticateWebSocketUpgrade(request);
              const socket = yield* request.upgrade;
              const write = yield* socket.writer;
              yield* socket.runString((frame) => write(frame));
              return HttpServerResponse.empty();
            }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
          ),
        );
        const requestCounts = new Map<number, number>();
        const startListener = () =>
          Layer.build(
            HttpRouter.serve(httpRoutes, {
              disableListenLog: true,
              disableLogger: true,
            }).pipe(
              Layer.provide(common),
              Layer.provideMerge(
                NodeHttpServer.layer(
                  () =>
                    NodeHttps.createServer({ key, cert }, (request) => {
                      const port = request.socket.localPort;
                      if (port !== undefined) {
                        requestCounts.set(port, (requestCounts.get(port) ?? 0) + 1);
                      }
                      // Match the trusted HTTPS proxy metadata supplied by relay/Serve termination.
                      request.headers["x-forwarded-proto"] = "https";
                    }),
                  {
                    host: "127.0.0.1",
                    port: 0,
                  },
                ),
              ),
            ),
          ).pipe(
            Effect.map((context) => {
              const { address } = Context.get(context, HttpServer.HttpServer);
              if (address._tag !== "TcpAddress") throw new Error("Expected a TCP listener");
              return `https://127.0.0.1:${address.port}`;
            }),
          );
        const relayOrigin = yield* startListener();
        const directOrigin = yield* startListener();
        const directEndpoint = createAdvertisedEndpoint({
          id: "integration-direct",
          label: "Controlled TLS route",
          provider: { id: "test", label: "Test", kind: "private-network", isAddon: false },
          httpBaseUrl: directOrigin,
          reachability: "private-network",
          source: "server",
        });
        advertised = [directEndpoint];
        const grant = yield* auth.issuePairingCredential({
          label: "Routing integration client",
          scopes: AuthStandardClientScopes,
          proofKeyThumbprint: signer.thumbprint,
        });
        const tokens = new Map<EnvironmentId, TokenStore.RemoteDpopAccessToken>();
        const identity = { accountId: "routing-account", sessionId: "routing-session" };
        const dependencies = Layer.mergeAll(
          NodeHttpClient.layerNodeHttpNoAgent.pipe(
            Layer.provide(NodeHttpClient.layerAgentOptions({ ca: cert })),
          ),
          Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer.service),
          Layer.succeed(Capabilities.ClientPresentation, {
            metadata: { label: "Routing integration client", deviceType: "mobile", os: "Test" },
            scopes: AuthStandardClientScopes,
            automaticRoutePromotion: true,
          }),
          Layer.mock(Capabilities.CloudSession)({
            identity: Effect.succeed(Option.some(identity)),
          }),
          TokenStore.layer({
            get: (id) => Effect.sync(() => Option.fromUndefinedOr(tokens.get(id))),
            put: (token) =>
              Effect.sync(() => {
                tokens.set(token.environmentId, token);
              }),
            remove: (id) =>
              Effect.sync(() => {
                tokens.delete(id);
              }),
          }),
        );
        yield* Effect.gen(function* () {
          const authorization = yield* Authorization.RemoteEnvironmentAuthorization;
          const promotion = yield* Promotion.ConnectionPromotion;
          const authorized = yield* authorization.authorizeDpop({
            expectedEnvironmentId: environmentId,
            relayUrl: relayOrigin,
            obtainBootstrap: Effect.succeed({
              environmentId,
              endpoint: {
                httpBaseUrl: relayOrigin,
                wsBaseUrl: relayOrigin.replace("https:", "wss:"),
                providerKind: "manual",
              },
              credential: grant.credential,
            }),
          });
          const prepared = {
            ...authorized,
            target: new RelayConnectionTarget({ environmentId, label: descriptor.label }),
          };
          const route = yield* promotion.discover(prepared);
          expect(discoveryReads).toBe(1);
          expect(Option.isSome(route)).toBe(true);
          expect(Option.getOrThrow(route).httpBaseUrl).toBe(`${directOrigin}/`);
          const direct = yield* authorization.authorizeDpopDirect({
            expectedEnvironmentId: environmentId,
            endpoint: { ...Option.getOrThrow(route), relayUrl: relayOrigin },
            obtainBootstrap: Effect.die("A valid cached token must not bootstrap again"),
          });
          expect(new URL(direct.socketUrl).origin).toBe(directOrigin.replace("https:", "wss:"));
          expect(direct.httpAuthorization._tag).toBe("Dpop");
          expect(tokens.get(environmentId)?.endpoint.httpBaseUrl).toBe(relayOrigin);
          const client = yield* HttpClient.HttpClient;
          const sessionUrl = `${directOrigin}/api/auth/session`;
          const relayPort = Number(new URL(relayOrigin).port);
          const relayRequestsBeforeRead = requestCounts.get(relayPort);
          const headers = yield* buildEnvironmentAuthHeaders(
            direct.httpAuthorization,
            "GET",
            sessionUrl,
            Option.some(signer.service),
          );
          const session = yield* client.get(sessionUrl, { headers: { ...headers } });
          expect(session.status).toBe(200);
          expect(yield* session.json).toMatchObject({ authenticated: true });
          expect(requestCounts.get(relayPort)).toBe(relayRequestsBeforeRead);
          const rejectedUpgrades: Array<number | undefined> = [];
          const roundTrip = (socketUrl: string, frame: string) =>
            Effect.acquireUseRelease(
              Effect.sync(() => new NodeSocket.NodeWS.WebSocket(socketUrl, { ca: cert })),
              (socket) =>
                Effect.tryPromise(
                  () =>
                    new Promise<string>((resolve, reject) => {
                      socket.once("error", reject);
                      socket.once("unexpected-response", (_request, response) => {
                        rejectedUpgrades.push(response.statusCode);
                        response.resume();
                        reject(new Error("WebSocket upgrade rejected"));
                      });
                      socket.once("open", () => socket.send(frame));
                      socket.once("message", (data) => resolve(data.toString()));
                    }),
                ),
              (socket) => Effect.sync(() => socket.terminate()),
            ).pipe(Effect.timeout("3 seconds"));
          expect(yield* roundTrip(direct.socketUrl, "direct-stream")).toBe("direct-stream");
          const replay = yield* roundTrip(direct.socketUrl, "must-not-replay").pipe(Effect.result);
          expect(replay._tag).toBe("Failure");
          expect(rejectedUpgrades).toEqual([401]);
          const relay = yield* authorization.authorizeDpop({
            expectedEnvironmentId: environmentId,
            relayUrl: relayOrigin,
            obtainBootstrap: Effect.die("A valid cached token must not bootstrap again"),
          });
          expect(new URL(relay.socketUrl).origin).toBe(relayOrigin.replace("https:", "wss:"));
          expect(yield* roundTrip(relay.socketUrl, "relay-stream")).toBe("relay-stream");
          const denied = yield* client.get(`${relayOrigin}/api/remote-access/endpoints`);
          expect(denied.status).toBe(401);
          expect(discoveryReads).toBe(1);
          yield* promotion.reportOverrideFailed(environmentId);
          expect(Option.isNone(yield* promotion.overrideFor(environmentId))).toBe(true);
          expect(Option.isNone(yield* promotion.discover(prepared))).toBe(true);
          expect(discoveryReads).toBe(2);
          yield* promotion.clear(environmentId);
          advertised = [
            {
              ...directEndpoint,
              id: "insecure-websocket",
              wsBaseUrl: directOrigin.replace("https:", "ws:"),
            },
          ];
          expect(Option.isNone(yield* promotion.discover(prepared))).toBe(true);
          expect(discoveryReads).toBe(3);
          expect(tokens.get(environmentId)?.endpoint.httpBaseUrl).toBe(relayOrigin);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(Authorization.layer, Promotion.layer).pipe(
              Layer.provideMerge(dependencies),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
