import { AuthStandardClientScopes, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ManagedRelay from "../relay/managedRelay.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "./service.ts";
import * as TokenStore from "./tokenStore.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
  providerKind: "cloudflare_tunnel" as const,
};
const DESCRIPTOR = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  platform: {
    os: "linux",
    arch: "x64",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};
const BOOTSTRAP: RemoteEnvironmentAuthorization.RelayEnvironmentAuthorization = {
  environmentId: ENVIRONMENT_ID,
  endpoint: ENDPOINT,
  credential: "relay-bootstrap",
};
const RELAY_URL = "https://relay.example.test";
const TOKEN_OWNER = {
  accountId: "account-1",
  authorizationScope: [...AuthStandardClientScopes].sort().join(" "),
  relayUrl: RELAY_URL,
};

function recordedFetch(responses: ReadonlyArray<Response>) {
  const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    return response === undefined
      ? Promise.reject(new Error(`Unexpected fetch call to ${String(input)}`))
      : Promise.resolve(response);
  }) satisfies typeof fetch;
  return { calls, fetchFn };
}

const websocketTicket = (ticket: string) =>
  Response.json({
    ticket,
    expiresAt: "2026-06-06T01:00:00.000Z",
  });

const accessToken = (token: string) =>
  Response.json({
    access_token: token,
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    token_type: "DPoP",
    expires_in: 3_600,
    scope: AuthStandardClientScopes.join(" "),
  });

const authInvalid = () =>
  Response.json(
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-auth-invalid",
    },
    { status: 401 },
  );

const makeHarness = Effect.fn("TestRemoteAuthorization.makeHarness")(function* (input: {
  readonly initialToken?: TokenStore.RemoteDpopAccessToken;
  readonly responses: ReadonlyArray<Response>;
}) {
  const tokens = yield* Ref.make(
    new Map(
      input.initialToken === undefined
        ? []
        : [[input.initialToken.environmentId, input.initialToken]],
    ),
  );
  const bootstrapCalls = yield* Ref.make(0);
  const account = yield* Ref.make<Option.Option<ClientCapabilities.CloudSessionIdentity>>(
    Option.some({ accountId: "account-1" }),
  );
  const proofInputs = yield* Ref.make<
    ReadonlyArray<{
      readonly method: string;
      readonly url: string;
      readonly accessToken?: string;
    }>
  >([]);
  const fetch = recordedFetch(input.responses);

  const tokenStore = TokenStore.RemoteDpopAccessTokenStore.of({
    get: (environmentId) =>
      Ref.get(tokens).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
      ),
    put: (token) =>
      Ref.update(tokens, (current) => {
        const next = new Map(current);
        next.set(token.environmentId, token);
        return next;
      }),
    remove: (environmentId) =>
      Ref.update(tokens, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }),
  });
  const signer = ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("thumbprint-1"),
    createProof: (proofInput) =>
      Ref.update(proofInputs, (current) => [...current, proofInput]).pipe(
        Effect.as(`proof:${proofInput.url}`),
      ),
  });
  const layer = RemoteEnvironmentAuthorization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        remoteHttpClientLayer(fetch.fetchFn),
        Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
        Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, tokenStore),
        Layer.succeed(ClientCapabilities.CloudSession, {
          identity: Ref.get(account),
          clerkToken: Effect.succeed("clerk-token"),
        }),
        Layer.succeed(
          ClientCapabilities.ClientPresentation,
          ClientCapabilities.ClientPresentation.of({
            metadata: {
              label: "T3 Code Test",
              deviceType: "mobile",
              os: "test",
            },
            scopes: AuthStandardClientScopes,
          }),
        ),
      ),
    ),
  );
  const obtainBootstrap = Ref.update(bootstrapCalls, (count) => count + 1).pipe(
    Effect.as(BOOTSTRAP),
  );

  return {
    layer,
    tokens,
    bootstrapCalls,
    account,
    proofInputs,
    fetch,
    obtainBootstrap,
  };
});

describe("RemoteEnvironmentAuthorization", () => {
  it.effect("renews concurrent HTTP requests once without minting another websocket ticket", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          accessToken("first"),
          websocketTicket("first-ticket"),
          Response.json(DESCRIPTOR),
          accessToken("second"),
        ],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorized = yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
          relayUrl: RELAY_URL,
          obtainBootstrap: harness.obtainBootstrap,
        });
        if (
          authorized.httpAuthorization._tag !== "Dpop" ||
          !authorized.httpAuthorization.renewAccessToken
        ) {
          return yield* Effect.die("Expected renewable DPoP authorization");
        }
        const renew = authorized.httpAuthorization.renewAccessToken;
        const values = yield* Effect.all([renew("first"), renew("first"), renew("first")], {
          concurrency: "unbounded",
        });
        expect(values).toEqual(["second", "second", "second"]);
        expect(
          harness.fetch.calls.filter(([url]) => String(url).includes("websocket-ticket")),
        ).toHaveLength(1);
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "does not reuse an old account's prepared HTTP authorization after switching accounts",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          responses: [Response.json(DESCRIPTOR), accessToken("first"), websocketTicket("ticket")],
        });
        yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          const authorized = yield* remote.authorizeDpop({
            expectedEnvironmentId: ENVIRONMENT_ID,
            relayUrl: RELAY_URL,
            obtainBootstrap: harness.obtainBootstrap,
          });
          yield* Ref.set(harness.account, Option.some({ accountId: "account-2" }));
          if (
            authorized.httpAuthorization._tag !== "Dpop" ||
            !authorized.httpAuthorization.renewAccessToken
          ) {
            return yield* Effect.die("Expected renewable DPoP authorization");
          }
          const failure = yield* authorized.httpAuthorization.renewAccessToken().pipe(Effect.flip);
          expect(failure._tag).toBe("ConnectionBlockedError");
          expect(harness.fetch.calls).toHaveLength(3);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("discards a late bootstrap completion after an account switch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ responses: [] });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const failure = yield* remote
          .authorizeDpop({
            expectedEnvironmentId: ENVIRONMENT_ID,
            relayUrl: RELAY_URL,
            obtainBootstrap: Ref.set(harness.account, Option.some({ accountId: "account-2" })).pipe(
              Effect.as(BOOTSTRAP),
            ),
          })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("ConnectionBlockedError");
        expect((yield* Ref.get(harness.tokens)).size).toBe(0);
        expect(harness.fetch.calls).toHaveLength(0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  for (const change of [
    { accountId: "other-account" },
    { relayUrl: "https://other-relay.example.test" },
    { authorizationScope: "orchestration:read" },
    { dpopThumbprint: "other-key" },
  ]) {
    it.effect(
      `invalidates persisted tokens with different ownership: ${Object.keys(change)[0]}`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({
            initialToken: new TokenStore.RemoteDpopAccessToken({
              ...TOKEN_OWNER,
              environmentId: ENVIRONMENT_ID,
              label: DESCRIPTOR.label,
              endpoint: ENDPOINT,
              accessToken: "old-token",
              expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
              dpopThumbprint: "thumbprint-1",
              ...change,
            }),
            responses: [
              Response.json(DESCRIPTOR),
              accessToken("new-token"),
              websocketTicket("new-ticket"),
            ],
          });
          yield* Effect.gen(function* () {
            const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
            yield* remote.authorizeDpop({
              expectedEnvironmentId: ENVIRONMENT_ID,
              relayUrl: RELAY_URL,
              obtainBootstrap: harness.obtainBootstrap,
            });
            expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
          }).pipe(Effect.provide(harness.layer));
        }),
    );
  }

  it.effect("rejects a rerouted cached endpoint before sending its access token", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialToken: new TokenStore.RemoteDpopAccessToken({
          ...TOKEN_OWNER,
          environmentId: ENVIRONMENT_ID,
          label: DESCRIPTOR.label,
          endpoint: ENDPOINT,
          accessToken: "cached",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          dpopThumbprint: "thumbprint-1",
        }),
        responses: [Response.json({ ...DESCRIPTOR, environmentId: "different-environment" })],
      });
      const failure = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
          relayUrl: RELAY_URL,
          obtainBootstrap: harness.obtainBootstrap,
        });
      }).pipe(Effect.provide(harness.layer), Effect.flip);
      expect(failure._tag).toBe("ConnectionBlockedError");
      expect(harness.fetch.calls).toHaveLength(1);
      expect(new Headers(harness.fetch.calls[0]?.[1].headers).has("authorization")).toBe(false);
    }),
  );
  it.effect("reuses a valid persisted environment token without contacting the relay", () =>
    Effect.gen(function* () {
      const cached = new TokenStore.RemoteDpopAccessToken({
        ...TOKEN_OWNER,
        environmentId: ENVIRONMENT_ID,
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "cached-access-token",
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: cached,
        responses: [Response.json(DESCRIPTOR), websocketTicket("cached-ticket")],
      });

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          relayUrl: RELAY_URL,
          expectedEnvironmentId: ENVIRONMENT_ID,
          obtainBootstrap: harness.obtainBootstrap,
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=cached-ticket");
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(0);
      expect(harness.fetch.calls).toHaveLength(2);
      expect(String(harness.fetch.calls[1]?.[0])).toBe(
        "https://environment.example.test/api/auth/websocket-ticket",
      );
    }),
  );

  it.effect("refreshes and persists an expired environment token", () =>
    Effect.gen(function* () {
      const expired = new TokenStore.RemoteDpopAccessToken({
        ...TOKEN_OWNER,
        environmentId: ENVIRONMENT_ID,
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "expired-access-token",
        expiresAtEpochMs: 0,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: expired,
        responses: [
          Response.json(DESCRIPTOR),
          accessToken("fresh-access-token"),
          websocketTicket("fresh-ticket"),
        ],
      });

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          relayUrl: RELAY_URL,
          expectedEnvironmentId: ENVIRONMENT_ID,
          obtainBootstrap: harness.obtainBootstrap,
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=fresh-ticket");
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)).toEqual(
        expect.objectContaining({
          accessToken: "fresh-access-token",
          dpopThumbprint: "thumbprint-1",
        }),
      );
      expect(harness.fetch.calls).toHaveLength(3);
    }),
  );

  it.effect("evicts an auth-invalid cached token and obtains a fresh bootstrap", () =>
    Effect.gen(function* () {
      const cached = new TokenStore.RemoteDpopAccessToken({
        ...TOKEN_OWNER,
        environmentId: ENVIRONMENT_ID,
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "invalid-access-token",
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: cached,
        responses: [
          Response.json(DESCRIPTOR),
          authInvalid(),
          Response.json(DESCRIPTOR),
          accessToken("replacement-access-token"),
          websocketTicket("replacement-ticket"),
        ],
      });

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          relayUrl: RELAY_URL,
          expectedEnvironmentId: ENVIRONMENT_ID,
          obtainBootstrap: harness.obtainBootstrap,
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=replacement-ticket");
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)).toEqual(
        expect.objectContaining({
          accessToken: "replacement-access-token",
        }),
      );
      expect(harness.fetch.calls).toHaveLength(5);
    }),
  );

  it.effect("refreshes a cached endpoint after consecutive transient failures", () =>
    Effect.gen(function* () {
      const cached = new TokenStore.RemoteDpopAccessToken({
        ...TOKEN_OWNER,
        environmentId: ENVIRONMENT_ID,
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "cached-access-token",
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: cached,
        responses: [
          new Response("endpoint unavailable", { status: 503 }),
          new Response("endpoint still unavailable", { status: 503 }),
          Response.json(DESCRIPTOR),
          accessToken("replacement-access-token"),
          websocketTicket("replacement-ticket"),
        ],
      });

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const firstFailure = yield* remote
          .authorizeDpop({
            relayUrl: RELAY_URL,
            expectedEnvironmentId: ENVIRONMENT_ID,
            obtainBootstrap: harness.obtainBootstrap,
          })
          .pipe(Effect.flip);

        expect(firstFailure._tag).toBe("ConnectionTransientError");
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(0);
        expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)).toBe(cached);

        return yield* remote.authorizeDpop({
          relayUrl: RELAY_URL,
          expectedEnvironmentId: ENVIRONMENT_ID,
          obtainBootstrap: harness.obtainBootstrap,
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=replacement-ticket");
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)).toEqual(
        expect.objectContaining({
          accessToken: "replacement-access-token",
        }),
      );
      expect(harness.fetch.calls).toHaveLength(5);
    }),
  );

  it.effect("does not persist a refreshed token until its websocket ticket succeeds", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          accessToken("unusable-access-token"),
          new Response("endpoint unavailable", { status: 503 }),
        ],
      });

      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          relayUrl: RELAY_URL,
          expectedEnvironmentId: ENVIRONMENT_ID,
          obtainBootstrap: harness.obtainBootstrap,
        });
      }).pipe(Effect.provide(harness.layer), Effect.flip);

      expect((yield* Ref.get(harness.tokens)).has(ENVIRONMENT_ID)).toBe(false);
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect(harness.fetch.calls).toHaveLength(3);
    }),
  );
});
