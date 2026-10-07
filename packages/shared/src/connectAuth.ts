const CONNECT_AUTHORIZE_PATH = "/connect";
const CONNECT_LOOPBACK_CALLBACK_PATH = "/callback";
const CONNECT_LOOPBACK_PORT_PARAM = "port";

export const DEFAULT_HOSTED_APP_URL = "https://app.t3.codes";
/**
 * Requested at authorize time by the hosted page and by the CLI's device
 * authorization request; keep both sides on this single definition.
 * `offline_access` asks Clerk for the refresh token the CLI relies on.
 */
export const CONNECT_OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

export function normalizeHostedAppUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export interface ConnectAuthorizeRequest {
  readonly state: string;
  readonly challenge: string;
  /**
   * The hosted /connect page asks Clerk to redirect the authorization code
   * straight to `http://127.0.0.1:<port>/callback` on the waiting CLI.
   */
  readonly loopbackPort: number;
}

/**
 * The CLI routes through the hosted /connect page rather than hitting
 * Clerk's /oauth/authorize directly: a signed-out browser sent straight to
 * /oauth/authorize goes through Clerk's sign-in redirect, which does not
 * reliably preserve the authorize query parameters (state, response_type,
 * code_challenge). The hosted page waits for a Clerk session first, then
 * forwards the request with the parameters intact. Headless hosts use the
 * OAuth device authorization grant instead and never involve this page.
 */
export function buildConnectAuthorizeRequestUrl(input: {
  readonly hostedAppUrl: string;
  readonly state: string;
  readonly challenge: string;
  readonly loopbackPort: number;
}): string {
  const url = new URL(CONNECT_AUTHORIZE_PATH, input.hostedAppUrl);
  url.hash = new URLSearchParams([
    ["state", input.state],
    ["challenge", input.challenge],
    [CONNECT_LOOPBACK_PORT_PARAM, String(input.loopbackPort)],
  ]).toString();
  return url.toString();
}

export function readConnectAuthorizeRequest(url: URL): ConnectAuthorizeRequest | null {
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const state = params.get("state")?.trim() ?? "";
  const challenge = params.get("challenge")?.trim() ?? "";
  const loopbackPort = parseLoopbackPort(params.get(CONNECT_LOOPBACK_PORT_PARAM)?.trim() ?? "");
  if (!state || !challenge || loopbackPort === null) return null;

  return { state, challenge, loopbackPort };
}

function parseLoopbackPort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

export function connectLoopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CONNECT_LOOPBACK_CALLBACK_PATH}`;
}

export function buildConnectClerkAuthorizeUrl(input: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: ReadonlyArray<string>;
  readonly state: string;
  readonly challenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}
