import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildConnectCliAuthorizeUrl,
  connectCliSignInRedirectUrl,
  isConnectCliAuthEnabled,
  isConnectAccountManagementEnabled,
} from "./connectCliAuth";

const TEST_PUBLISHABLE_KEY = `pk_test_${btoa("clerk.example.test$")}`;

describe("connectCliAuth", () => {
  it("enables hosted account management without a CLI OAuth client", () => {
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "");
    vi.stubGlobal("window", {
      location: { href: "https://hosted.example.test/connect/environments" },
    });
    expect(isConnectAccountManagementEnabled()).toBe(true);
    expect(isConnectCliAuthEnabled()).toBe(false);

    vi.stubEnv("VITE_HTTP_URL", "http://127.0.0.1:13773");
    expect(isConnectAccountManagementEnabled()).toBe(false);
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubGlobal("window", { location: { href: "http://127.0.0.1:5733/connect/environments" } });
    expect(isConnectAccountManagementEnabled()).toBe(false);
  });

  it.each(["", "http://relay.example.test", "https://user:password@relay.example.test"])(
    "keeps account management disabled without a secure relay: %s",
    (relayUrl) => {
      vi.stubEnv("VITE_HTTP_URL", "");
      vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
      vi.stubEnv("VITE_T3CODE_RELAY_URL", relayUrl);
      vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauth-client");
      vi.stubGlobal("window", {
        location: { href: "https://hosted.example.test/connect/environments" },
      });
      expect(isConnectAccountManagementEnabled()).toBe(false);
      expect(isConnectCliAuthEnabled()).toBe(true);
    },
  );

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the CLI listener for loopback authorization and sign-in handoff", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauth-client");

    const request = {
      state: "state-1",
      challenge: "challenge-1",
      loopbackPort: 34338,
    } as const;
    const authorizeUrl = connectCliSignInRedirectUrl(
      request,
      "https://hosted.example.test/connect",
    );
    const url = new URL(authorizeUrl);

    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:34338/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("builds a PKCE authorize URL that redirects to the CLI's loopback listener", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauth-client");

    const url = new URL(
      buildConnectCliAuthorizeUrl({
        state: "state-1",
        challenge: "challenge-1",
        loopbackPort: 34338,
      })!,
    );

    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:34338/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("returns null when the CLI OAuth client id is not configured", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "");
    expect(
      buildConnectCliAuthorizeUrl({
        state: "state-1",
        challenge: "challenge-1",
        loopbackPort: 34338,
      }),
    ).toBeNull();
  });

  it("enables Clerk only on the configured hosted origin", () => {
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauth-client");
    vi.stubGlobal("window", {
      location: { href: "https://hosted.example.test/connect" },
    });
    expect(isConnectCliAuthEnabled()).toBe(true);

    vi.stubGlobal("window", {
      location: { href: "http://127.0.0.1:5733/connect" },
    });
    expect(isConnectCliAuthEnabled()).toBe(false);
  });
});
