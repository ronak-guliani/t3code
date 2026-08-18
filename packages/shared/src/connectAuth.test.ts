import { assert, it } from "@effect/vitest";

import {
  buildConnectAuthorizeRequestUrl,
  checkConnectAuthCode,
  connectCallbackUrl,
  connectLoopbackRedirectUri,
  encodeConnectAuthCode,
  readConnectAuthorizeRequest,
} from "./connectAuth.ts";

it("keeps the headless OAuth state and challenge in the browser-only URL fragment", () => {
  const url = new URL(
    buildConnectAuthorizeRequestUrl({
      hostedAppUrl: "https://app.example.test",
      state: "expected-state",
      challenge: "pkce-challenge",
    }),
  );

  assert.equal(url.pathname, "/connect");
  assert.equal(url.search, "");
  assert.deepEqual(readConnectAuthorizeRequest(url), {
    state: "expected-state",
    challenge: "pkce-challenge",
  });
  assert.equal(
    connectCallbackUrl("https://app.example.test"),
    "https://app.example.test/connect/callback",
  );
});

it("round-trips a valid loopback port and rejects corrupted ports", () => {
  const url = new URL(
    buildConnectAuthorizeRequestUrl({
      hostedAppUrl: "https://app.example.test",
      state: "expected-state",
      challenge: "pkce-challenge",
      loopbackPort: 34338,
    }),
  );

  assert.deepEqual(readConnectAuthorizeRequest(url), {
    state: "expected-state",
    challenge: "pkce-challenge",
    loopbackPort: 34338,
  });
  assert.equal(connectLoopbackRedirectUri(34338), "http://127.0.0.1:34338/callback");

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

it("rejects malformed and cross-request authorization codes", () => {
  assert.equal(
    checkConnectAuthCode("not-a-code", "expected-state"),
    "That does not look like a T3 Connect code. Copy the full code.",
  );
  assert.equal(
    checkConnectAuthCode("clerk-code.other-state", "expected-state"),
    "That code belongs to a different connect request. Open the URL above and try again.",
  );
  assert.deepEqual(
    checkConnectAuthCode(
      encodeConnectAuthCode({ code: "clerk-code", state: "expected-state" }),
      "expected-state",
    ),
    { code: "clerk-code", state: "expected-state" },
  );
});
