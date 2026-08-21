import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
} from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import { Effect, Layer } from "effect";

import type { ServerConfigShape } from "../../config.ts";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BootstrapCredentialError } from "../Services/BootstrapCredentialService.ts";
import { ServerAuth, type ServerAuthShape } from "../Services/ServerAuth.ts";
import { ServerAuthLive, toBootstrapExchangeAuthError } from "./ServerAuth.ts";
import { ServerSecretStoreLive } from "./ServerSecretStore.ts";

const makeServerConfigLayer = (overrides?: Partial<ServerConfigShape>) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfigShape;
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-server-test-" })));

const makeServerAuthLayer = (overrides?: Partial<ServerConfigShape>) =>
  ServerAuthLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

const makeCookieRequest = (
  sessionToken: string,
): Parameters<ServerAuthShape["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {
      t3_session: sessionToken,
    },
    headers: {},
  }) as unknown as Parameters<ServerAuthShape["authenticateHttpRequest"]>[0];

const makeAuthorizationRequest = (input: {
  readonly authorization: string;
  readonly dpop?: string;
  readonly url: string;
}): Parameters<ServerAuthShape["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {},
    headers: {
      authorization: input.authorization,
      ...(input.dpop ? { dpop: input.dpop } : {}),
    },
    method: "POST",
    url: input.url,
  }) as unknown as Parameters<ServerAuthShape["authenticateHttpRequest"]>[0];

function signDpopProof(input: {
  readonly url: string;
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicJwk: DpopPublicJwk;
  readonly accessToken?: string;
}) {
  const header = Buffer.from(
    JSON.stringify({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: input.publicJwk,
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: "POST",
      htu: input.url,
      jti: crypto.randomUUID(),
      iat: Math.floor(Date.now() / 1_000),
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

it.layer(NodeServices.layer)("ServerAuthLive", (it) => {
  it.effect("maps invalid bootstrap credential failures to 401", () =>
    Effect.sync(() => {
      const error = toBootstrapExchangeAuthError(
        new BootstrapCredentialError({
          message: "Unknown bootstrap credential.",
          status: 401,
        }),
      );

      expect(error.status).toBe(401);
      expect(error.message).toBe("Invalid bootstrap credential.");
    }),
  );

  it.effect("maps unexpected bootstrap failures to 500", () =>
    Effect.sync(() => {
      const error = toBootstrapExchangeAuthError(
        new BootstrapCredentialError({
          message: "Failed to consume bootstrap credential.",
          status: 500,
          cause: new Error("sqlite is unavailable"),
        }),
      );

      expect(error.status).toBe(500);
      expect(error.message).toBe("Failed to validate bootstrap credential.");
    }),
  );

  it.effect("issues client pairing credentials by default", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const pairingCredential = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.exchangeBootstrapCredential(
        pairingCredential.credential,
        requestMetadata,
      );

      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(exchanged.sessionToken),
      );

      expect(verified.sessionId.length).toBeGreaterThan(0);
      expect(verified.role).toBe("client");
      expect(verified.subject).toBe("one-time-token");
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("exchanges pairing credentials for scoped OAuth access tokens", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        label: "Official iOS",
      });
      const access = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairingCredential.credential,
        [AuthOrchestrationReadScope, AuthTerminalOperateScope],
        {
          ...requestMetadata,
          deviceType: "mobile",
          os: "iOS",
        },
      );
      const session = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(access.access_token),
      );

      expect(access.issued_token_type).toBe(AuthAccessTokenType);
      expect(access.token_type).toBe("Bearer");
      expect(access.scope).toBe("orchestration:read terminal:operate");
      expect(session.method).toBe("bearer-access-token");
      expect(session.scopes).toEqual([AuthOrchestrationReadScope, AuthTerminalOperateScope]);
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("binds managed access tokens to the official client's DPoP key", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;
      const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
        namedCurve: "P-256",
      });
      const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
      const proofKeyThumbprint = computeDpopJwkThumbprint(publicJwk);
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        label: "Official iOS",
        proofKeyThumbprint,
      });
      const access = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairingCredential.credential,
        [AuthOrchestrationReadScope],
        {
          ...requestMetadata,
          deviceType: "mobile",
          os: "iOS",
        },
        proofKeyThumbprint,
      );
      const requestUrl = "https://environment.example.test/api/auth/websocket-ticket";
      const proof = signDpopProof({
        url: requestUrl,
        privateKey,
        publicJwk,
        accessToken: access.access_token,
      });
      const session = yield* serverAuth.authenticateHttpRequest(
        makeAuthorizationRequest({
          authorization: `DPoP ${access.access_token}`,
          dpop: proof,
          url: requestUrl,
        }),
      );
      const replayFailure = yield* Effect.flip(
        serverAuth.authenticateHttpRequest(
          makeAuthorizationRequest({
            authorization: `DPoP ${access.access_token}`,
            dpop: proof,
            url: requestUrl,
          }),
        ),
      );
      const websocketTokenFailure = yield* Effect.flip(serverAuth.issueWebSocketToken(session));
      const websocketTicket = yield* serverAuth.issueWebSocketTicket(session);
      const bearerFailure = yield* Effect.flip(
        serverAuth.authenticateHttpRequest(
          makeAuthorizationRequest({
            authorization: `Bearer ${access.access_token}`,
            url: requestUrl,
          }),
        ),
      );
      const cookieFailure = yield* Effect.flip(
        serverAuth.authenticateHttpRequest(makeCookieRequest(access.access_token)),
      );
      const secondPairingCredential = yield* serverAuth.issuePairingCredential({
        label: "Official iOS retry",
        proofKeyThumbprint,
      });
      const legacyExchangeFailure = yield* Effect.flip(
        serverAuth.exchangeBootstrapCredential(secondPairingCredential.credential, requestMetadata),
      );
      const wrongKeyFailure = yield* Effect.flip(
        serverAuth.exchangeBootstrapCredentialForAccessToken(
          secondPairingCredential.credential,
          [AuthOrchestrationReadScope],
          requestMetadata,
          "wrong-thumbprint",
        ),
      );
      const retriedAccess = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        secondPairingCredential.credential,
        [AuthOrchestrationReadScope],
        requestMetadata,
        proofKeyThumbprint,
      );

      expect(access.token_type).toBe("DPoP");
      expect(session.method).toBe("dpop-access-token");
      expect(session.proofKeyThumbprint).toBe(proofKeyThumbprint);
      expect(replayFailure.status).toBe(401);
      expect(websocketTokenFailure.status).toBe(403);
      expect(websocketTicket.ticket.length).toBeGreaterThan(0);
      expect(bearerFailure.status).toBe(401);
      expect(cookieFailure.status).toBe(401);
      expect(legacyExchangeFailure.status).toBe(401);
      expect(wrongKeyFailure.status).toBe(401);
      expect(retriedAccess.token_type).toBe("DPoP");
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("rejects scope escalation from a client pairing credential", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential();
      const error = yield* Effect.flip(
        serverAuth.exchangeBootstrapCredentialForAccessToken(
          pairingCredential.credential,
          ["access:write"],
          requestMetadata,
        ),
      );

      expect(error.status).toBe(400);
      expect(error.environmentReason).toBe("scope_not_granted");
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("preserves restricted scopes from pairing credential through OAuth exchange", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        scopes: [AuthOrchestrationReadScope],
      });
      const access = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairingCredential.credential,
        undefined,
        requestMetadata,
      );
      const session = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(access.access_token),
      );

      expect(access.scope).toBe(AuthOrchestrationReadScope);
      expect(session.scopes).toEqual([AuthOrchestrationReadScope]);
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("preserves restricted scopes through legacy pairing exchanges", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;
      const browserCredential = yield* serverAuth.issuePairingCredential({
        scopes: [AuthOrchestrationReadScope],
      });
      const browserExchange = yield* serverAuth.exchangeBootstrapCredential(
        browserCredential.credential,
        requestMetadata,
      );
      const browserSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(browserExchange.sessionToken),
      );

      const bearerCredential = yield* serverAuth.issuePairingCredential({
        scopes: [AuthOrchestrationReadScope],
      });
      const bearerExchange = yield* serverAuth.exchangeBootstrapCredentialForBearerSession(
        bearerCredential.credential,
        requestMetadata,
      );
      const bearerSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(bearerExchange.sessionToken),
      );

      expect(browserSession.scopes).toEqual([AuthOrchestrationReadScope]);
      expect(bearerSession.scopes).toEqual([AuthOrchestrationReadScope]);
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("issues startup pairing URLs that bootstrap owner sessions", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
      const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      expect(token).toBeTruthy();
      expect(
        listedPairingLinks.some((pairingLink) => pairingLink.subject === "owner-bootstrap"),
      ).toBe(false);

      const exchanged = yield* serverAuth.exchangeBootstrapCredential(token ?? "", requestMetadata);
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(exchanged.sessionToken),
      );

      expect(verified.role).toBe("owner");
      expect(verified.subject).toBe("owner-bootstrap");
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("lists pairing links and revokes other client sessions while keeping the owner", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const ownerExchange = yield* serverAuth.exchangeBootstrapCredential(
        "desktop-bootstrap-token",
        requestMetadata,
      );
      const ownerSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(ownerExchange.sessionToken),
      );
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        label: "Julius iPhone",
      });
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      const clientExchange = yield* serverAuth.exchangeBootstrapCredential(
        pairingCredential.credential,
        {
          ...requestMetadata,
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      );
      const clientSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(clientExchange.sessionToken),
      );
      const clientsBeforeRevoke = yield* serverAuth.listClientSessions(ownerSession.sessionId);
      const revokedCount = yield* serverAuth.revokeOtherClientSessions(ownerSession.sessionId);
      const clientsAfterRevoke = yield* serverAuth.listClientSessions(ownerSession.sessionId);

      expect(listedPairingLinks.map((entry) => entry.id)).toContain(pairingCredential.id);
      expect(listedPairingLinks.find((entry) => entry.id === pairingCredential.id)?.label).toBe(
        "Julius iPhone",
      );
      expect(clientsBeforeRevoke).toHaveLength(2);
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === ownerSession.sessionId)?.current,
      ).toBe(true);
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.current,
      ).toBe(false);
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
          .label,
      ).toBe("Julius iPhone");
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
          .deviceType,
      ).toBe("mobile");
      expect(revokedCount).toBe(1);
      expect(clientsAfterRevoke).toHaveLength(1);
      expect(clientsAfterRevoke[0]?.sessionId).toBe(ownerSession.sessionId);
    }).pipe(
      Effect.provide(
        makeServerAuthLayer({
          desktopBootstrapToken: "desktop-bootstrap-token",
        }),
      ),
    ),
  );
});
