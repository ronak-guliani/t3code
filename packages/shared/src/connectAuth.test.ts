import { assert, it } from "@effect/vitest";

import {
  buildConnectAuthorizeRequestUrl,
  buildConnectClerkAuthorizeUrl,
  connectLoopbackRedirectUri,
  normalizeHostedAppUrl,
  readConnectAuthorizeRequest,
} from "./connectAuth.ts";

it("round-trips state, challenge, and loopback port through the authorize URL fragment", () => {
  const url = new URL(
    buildConnectAuthorizeRequestUrl({
      hostedAppUrl: "https://app.example.test",
      state: "expected-state",
      challenge: "pkce-challenge",
      loopbackPort: 34338,
    }),
  );

  assert.equal(url.pathname, "/connect");
  assert.equal(url.search, "");
  assert.deepEqual(readConnectAuthorizeRequest(url), {
    state: "expected-state",
    challenge: "pkce-challenge",
    loopbackPort: 34338,
  });
  assert.equal(connectLoopbackRedirectUri(34338), "http://127.0.0.1:34338/callback");
});

it("rejects authorize requests missing state, challenge, or port", () => {
  assert.isNull(readConnectAuthorizeRequest(new URL("https://app.example.test/connect")));
  assert.isNull(
    readConnectAuthorizeRequest(
      new URL("https://app.example.test/connect#state=expected-state&port=34338"),
    ),
  );
  assert.isNull(
    readConnectAuthorizeRequest(
      new URL("https://app.example.test/connect#challenge=pkce-challenge&port=34338"),
    ),
  );
  assert.isNull(
    readConnectAuthorizeRequest(
      new URL("https://app.example.test/connect#state=expected-state&challenge=pkce-challenge"),
    ),
  );
});

it("rejects authorize requests whose loopback port is corrupted", () => {
  for (const port of ["", "abc", "-1", "0", "65536", "34338x", "34 38"]) {
    assert.isNull(
      readConnectAuthorizeRequest(
        new URL(
          `https://app.example.test/connect#state=expected-state&challenge=pkce-challenge&port=${encodeURIComponent(port)}`,
        ),
      ),
    );
  }
});

it("builds the Clerk authorize URL against the loopback redirect", () => {
  const url = new URL(
    buildConnectClerkAuthorizeUrl({
      authorizationEndpoint: "https://clerk.example.test/oauth/authorize",
      clientId: "oauth-client",
      redirectUri: connectLoopbackRedirectUri(34338),
      scopes: ["openid", "profile", "email", "offline_access"],
      state: "expected-state",
      challenge: "pkce-challenge",
    }),
  );

  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:34338/callback");
  assert.equal(url.searchParams.get("scope"), "openid profile email offline_access");
  assert.equal(url.searchParams.get("state"), "expected-state");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

it("normalizes hosted app origins and rejects insecure or non-origin URLs", () => {
  assert.equal(normalizeHostedAppUrl("https://app.example.test"), "https://app.example.test");
  assert.equal(normalizeHostedAppUrl("http://127.0.0.1:5733"), "http://127.0.0.1:5733");
  for (const value of [
    "http://app.example.test",
    "https://app.example.test/path",
    "https://app.example.test?query=1",
    "https://app.example.test#fragment",
    "not-a-url",
  ]) {
    assert.isNull(normalizeHostedAppUrl(value));
  }
});
