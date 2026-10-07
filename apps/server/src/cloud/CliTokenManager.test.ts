import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CliTokenManager from "./CliTokenManager.ts";

const idToken = (claims: Readonly<Record<string, string>>) =>
  `header.${Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}.signature`;

it("routes loopback authorization through the hosted app", () => {
  const url = new URL(
    CliTokenManager.buildLoopbackAuthorizationUrl({
      hostedAppUrl: "https://app.example.test",
      loopbackPort: 34338,
      state: "loopback-state",
      challenge: "pkce-challenge",
    }),
  );

  assert.equal(url.origin, "https://app.example.test");
  assert.equal(url.pathname, "/connect");
  assert.equal(url.search, "");
  assert.equal(url.hash, "#state=loopback-state&challenge=pkce-challenge&port=34338");
});

function memorySecretStore() {
  const values = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
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
  });
}

it.effect(
  "accepts only a state-bound loopback callback and persists its exchanged credential",
  () =>
    Effect.gen(function* () {
      const secretStore = memorySecretStore();
      const layer = CliTokenManager.layer.pipe(
        Layer.provideMerge(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
        Layer.provideMerge(NodeServices.layer),
      );
      const state = "loopback-state";
      const run = CliTokenManager.withLoopbackAuthorizationCallback(
        {
          redirectUri: "http://127.0.0.1:34338/callback",
          state,
        },
        ({ awaitCode }) =>
          Effect.gen(function* () {
            const invalid = yield* Effect.promise(() =>
              fetch("http://127.0.0.1:34338/callback?code=invalid&state=wrong-state"),
            );
            assert.equal(invalid.status, 400);

            const valid = yield* Effect.promise(() =>
              fetch("http://127.0.0.1:34338/callback?code=loopback-code&state=loopback-state"),
            );
            assert.equal(valid.status, 200);
            const token = yield* CliTokenManager.exchangeOAuthToken(
              {
                tokenEndpoint: "https://clerk.example.test/oauth/token",
                deviceAuthorizationEndpoint:
                  "https://clerk.example.test/oauth/device_authorization",
                clientId: "oauth-client",
                loopbackPort: 34338,
                redirectUri: "http://127.0.0.1:34338/callback",
                scopes: ["openid", "profile", "email", "offline_access"],
              },
              {
                grant_type: "authorization_code",
                code: yield* awaitCode,
                redirect_uri: "http://127.0.0.1:34338/callback",
                client_id: "oauth-client",
                code_verifier: "verifier",
              },
            );
            const tokens = yield* CliTokenManager.CloudCliTokenManager;
            yield* tokens.store(token.token);
          }),
      );

      yield* run.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  access_token: "loopback-access-token",
                  refresh_token: "loopback-refresh-token",
                  expires_in: 3600,
                  token_type: "Bearer",
                }),
              ),
            ),
          ),
        ),
        Effect.provide(layer),
      );

      const stored = yield* Effect.gen(function* () {
        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        return yield* tokens.getExisting;
      }).pipe(Effect.provide(layer));
      assert.equal(Option.getOrThrow(stored).refreshToken, "loopback-refresh-token");
    }),
);

it.effect("persists a local-browser credential across token-manager restarts", () =>
  Effect.gen(function* () {
    const secretStore = memorySecretStore();
    const layer = CliTokenManager.layer.pipe(
      Layer.provideMerge(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const tokens = yield* CliTokenManager.CloudCliTokenManager;
      yield* tokens.store({
        accessToken: "opaque-access-token",
        refreshToken: "opaque-refresh-token",
        expiresAtEpochMs: Date.now() + 60 * 60 * 1_000,
      });
    }).pipe(Effect.provide(layer));

    const restored = yield* Effect.gen(function* () {
      const tokens = yield* CliTokenManager.CloudCliTokenManager;
      return yield* tokens.getExisting;
    }).pipe(Effect.provide(layer));

    assert.equal(Option.getOrThrow(restored).refreshToken, "opaque-refresh-token");
  }),
);

it.effect("surfaces a revoked refresh credential so Connect can reauthorize", () =>
  Effect.gen(function* () {
    const secretStore = memorySecretStore();
    const layer = CliTokenManager.layer.pipe(
      Layer.provideMerge(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
      Layer.provideMerge(NodeServices.layer),
    );
    const config = ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth-client",
        },
      }),
    );

    yield* Effect.gen(function* () {
      const tokens = yield* CliTokenManager.CloudCliTokenManager;
      yield* tokens.store({
        accessToken: "expired-access-token",
        refreshToken: "revoked-refresh-token",
        expiresAtEpochMs: 0,
      });
    }).pipe(Effect.provide(layer));

    const error = yield* Effect.gen(function* () {
      const tokens = yield* CliTokenManager.CloudCliTokenManager;
      return yield* tokens.getExisting.pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          config,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })),
              ),
            ),
          ),
        ),
      ),
    );
    assert.equal(error._tag, "CloudCliCredentialRefreshError");
  }),
);

interface RecordedTokenRequest {
  readonly url: string;
  readonly params: URLSearchParams;
}

interface DeviceFlowServer {
  readonly requests: Array<RecordedTokenRequest>;
  /** Token endpoint replies, consumed in order; the last one repeats. */
  readonly tokenReplies: Array<{ readonly status: number; readonly body: string }>;
  readonly failTransportOnce?: { value: boolean };
}

const DEVICE_AUTHORIZATION_BODY = JSON.stringify({
  device_code: "device-code-1",
  user_code: "BCDF-GHJK",
  verification_uri: "https://accounts.example.test/device",
  verification_uri_complete: "https://accounts.example.test/device?user_code=BCDF-GHJK",
  expires_in: 600,
  interval: 5,
});

const DEVICE_TEST_ENV = {
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth-client",
};

const provideDeviceTestEnv = Effect.provide(
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: DEVICE_TEST_ENV })),
);

const oauthError = (error: string) => ({ status: 400, body: JSON.stringify({ error }) });
const tokenGranted = {
  status: 200,
  body: JSON.stringify({
    access_token: "device-access-token",
    refresh_token: "device-refresh-token",
    id_token: idToken({ email: "user@example.test", sub: "account-123" }),
    expires_in: 3600,
    token_type: "Bearer",
  }),
};

const makeDeviceFlowLayer = (server: DeviceFlowServer) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        server.requests.push({ url: request.url, params: new URLSearchParams(body) });
        if (request.url.endsWith("/oauth/device_authorization")) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(DEVICE_AUTHORIZATION_BODY, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (server.failTransportOnce?.value) {
          server.failTransportOnce.value = false;
          return yield* Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: "connection reset",
              }),
            }),
          );
        }
        const reply =
          server.tokenReplies.length > 1
            ? server.tokenReplies.shift()!
            : (server.tokenReplies[0] ?? oauthError("invalid_grant"));
        return HttpClientResponse.fromWeb(
          request,
          new Response(reply.body, {
            status: reply.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

const tokenRequests = (requests: ReadonlyArray<RecordedTokenRequest>) =>
  requests.filter((request) => request.url.endsWith("/oauth/token"));

const isAuthorizationError = (error: unknown) =>
  error !== null &&
  typeof error === "object" &&
  "_tag" in error &&
  (error as { readonly _tag: string })._tag === "CloudCliAuthorizationError";

it.layer(NodeServices.layer)("CliTokenManager.deviceAuthorizationLogin", (it) => {
  it.effect("requests a device code, shows it, and polls until Clerk grants the token", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("authorization_pending"), tokenGranted],
      };
      const prompts: Array<CliTokenManager.DeviceAuthorizationPrompt> = [];

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin((prompt) =>
        Effect.sync(() => {
          prompts.push(prompt);
        }),
      ).pipe(Effect.provide(makeDeviceFlowLayer(server)), provideDeviceTestEnv, Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(10));
      const { token, identity } = yield* Fiber.join(fiber);

      assert.deepEqual(prompts, [
        {
          verificationUri: "https://accounts.example.test/device",
          verificationUriComplete: "https://accounts.example.test/device?user_code=BCDF-GHJK",
          userCode: "BCDF-GHJK",
          expiresIn: Duration.seconds(600),
        },
      ]);
      assert.equal(token.accessToken, "device-access-token");
      assert.equal(token.refreshToken, "device-refresh-token");
      assert.equal(token.identity, "user@example.test");
      assert.equal(token.accountId, "account-123");
      assert.equal(identity, "user@example.test");

      const authorization = server.requests[0]!;
      assert.equal(authorization.url, "https://clerk.example.test/oauth/device_authorization");
      assert.equal(authorization.params.get("client_id"), "oauth-client");
      assert.equal(authorization.params.get("scope"), "openid profile email offline_access");

      const polls = tokenRequests(server.requests);
      assert.lengthOf(polls, 2);
      for (const poll of polls) {
        assert.equal(poll.url, "https://clerk.example.test/oauth/token");
        assert.equal(poll.params.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
        assert.equal(poll.params.get("device_code"), "device-code-1");
        assert.equal(poll.params.get("client_id"), "oauth-client");
      }
    }),
  );

  it.effect("waits the advertised interval between polls and backs off on slow_down", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("slow_down"), oauthError("authorization_pending")],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(makeDeviceFlowLayer(server)),
        provideDeviceTestEnv,
        Effect.forkChild,
      );

      yield* TestClock.adjust(Duration.seconds(4));
      assert.lengthOf(tokenRequests(server.requests), 0);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.lengthOf(tokenRequests(server.requests), 1);
      // slow_down widens the 5s interval to 10s.
      yield* TestClock.adjust(Duration.seconds(9));
      assert.lengthOf(tokenRequests(server.requests), 1);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.lengthOf(tokenRequests(server.requests), 2);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("backs off after a transient upstream failure and keeps polling", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [{ status: 503, body: "upstream unavailable" }, tokenGranted],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(makeDeviceFlowLayer(server)),
        provideDeviceTestEnv,
        Effect.forkChild,
      );

      yield* TestClock.adjust(Duration.seconds(5));
      assert.lengthOf(tokenRequests(server.requests), 1);
      // The 5xx widens the 5s interval to 10s before the retry.
      yield* TestClock.adjust(Duration.seconds(9));
      assert.lengthOf(tokenRequests(server.requests), 1);
      yield* TestClock.adjust(Duration.seconds(1));
      const { token } = yield* Fiber.join(fiber);
      assert.lengthOf(tokenRequests(server.requests), 2);
      assert.equal(token.accessToken, "device-access-token");
    }),
  );

  it.effect("retries a transient transport error and keeps polling", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [tokenGranted],
        failTransportOnce: { value: true },
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(makeDeviceFlowLayer(server)),
        provideDeviceTestEnv,
        Effect.forkChild,
      );

      yield* TestClock.adjust(Duration.seconds(5));
      assert.lengthOf(tokenRequests(server.requests), 1);
      // The transport failure widens the 5s interval to 10s before the retry.
      yield* TestClock.adjust(Duration.seconds(9));
      assert.lengthOf(tokenRequests(server.requests), 1);
      yield* TestClock.adjust(Duration.seconds(1));
      const { token } = yield* Fiber.join(fiber);
      assert.lengthOf(tokenRequests(server.requests), 2);
      assert.equal(token.accessToken, "device-access-token");
    }),
  );

  it.effect("fails with a denied error when the user rejects the request", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("access_denied")],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(makeDeviceFlowLayer(server)),
        provideDeviceTestEnv,
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(5));
      const result = yield* Fiber.join(fiber);

      assert.instanceOf(result, CliTokenManager.CloudCliAuthorizationDeniedError);
      assert.lengthOf(tokenRequests(server.requests), 1);
    }),
  );

  it.effect("times out when Clerk reports the user code expired", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("expired_token")],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(makeDeviceFlowLayer(server)),
        provideDeviceTestEnv,
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(5));
      const result = yield* Fiber.join(fiber);

      assert.instanceOf(result, CliTokenManager.CloudCliAuthorizationTimeoutError);
    }),
  );

  it.effect("times out once the device code lifetime elapses", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("authorization_pending")],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(makeDeviceFlowLayer(server)),
        provideDeviceTestEnv,
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(600));
      const result = yield* Fiber.join(fiber);

      assert.instanceOf(result, CliTokenManager.CloudCliAuthorizationTimeoutError);
    }),
  );

  it.effect("supports cancellation while waiting for approval", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("authorization_pending")],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(makeDeviceFlowLayer(server)),
        provideDeviceTestEnv,
        Effect.forkChild,
      );

      yield* TestClock.adjust(Duration.seconds(5));
      assert.lengthOf(tokenRequests(server.requests), 1);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.isTrue(exit.cause.reasons.some(Cause.isInterruptReason));
      }
      assert.lengthOf(tokenRequests(server.requests), 1);
    }),
  );

  it.effect("surfaces other OAuth errors as authorization failures", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("invalid_client")],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(makeDeviceFlowLayer(server)),
        provideDeviceTestEnv,
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(5));
      const result = yield* Fiber.join(fiber);

      assert.isTrue(isAuthorizationError(result));
    }),
  );

  it.effect("fails without polling when the device grant is unavailable", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedTokenRequest> = [];
      const failure = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              const body =
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "";
              requests.push({ url: request.url, params: new URLSearchParams(body) });
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ error: "invalid_grant" }, { status: 400 }),
              );
            }),
          ),
        ),
        provideDeviceTestEnv,
        Effect.flip,
      );

      assert.isDefined(failure);
      assert.lengthOf(requests, 1);
      assert.lengthOf(tokenRequests(requests), 0);
    }),
  );
});
