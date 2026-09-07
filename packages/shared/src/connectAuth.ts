const CONNECT_AUTHORIZE_PATH = "/connect";
const CONNECT_CALLBACK_PATH = "/connect/callback";
const CONNECT_LOOPBACK_CALLBACK_PATH = "/callback";
const CONNECT_LOOPBACK_PORT_PARAM = "port";
const CONNECT_AUTH_CODE_SEPARATOR = ".";

export const DEFAULT_HOSTED_APP_URL = "https://app.t3.codes";
export const CONNECT_OAUTH_SCOPES = ["openid", "profile", "email"] as const;

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
  readonly loopbackPort?: number;
}

export function buildConnectAuthorizeRequestUrl(input: {
  readonly hostedAppUrl: string;
  readonly state: string;
  readonly challenge: string;
  readonly loopbackPort?: number;
}): string {
  const url = new URL(CONNECT_AUTHORIZE_PATH, input.hostedAppUrl);
  url.hash = new URLSearchParams([
    ["state", input.state],
    ["challenge", input.challenge],
    ...(input.loopbackPort === undefined
      ? []
      : [[CONNECT_LOOPBACK_PORT_PARAM, String(input.loopbackPort)] as [string, string]]),
  ]).toString();
  return url.toString();
}

export function readConnectAuthorizeRequest(url: URL): ConnectAuthorizeRequest | null {
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const state = params.get("state")?.trim() ?? "";
  const challenge = params.get("challenge")?.trim() ?? "";
  if (!state || !challenge) return null;

  const port = params.get(CONNECT_LOOPBACK_PORT_PARAM);
  if (port === null) return { state, challenge };

  const loopbackPort = parseLoopbackPort(port.trim());
  return loopbackPort === null ? null : { state, challenge, loopbackPort };
}

function parseLoopbackPort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

export function connectLoopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CONNECT_LOOPBACK_CALLBACK_PATH}`;
}

export function connectCallbackUrl(hostedAppUrl: string): string {
  return new URL(CONNECT_CALLBACK_PATH, hostedAppUrl).toString();
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

export function encodeConnectAuthCode(input: {
  readonly code: string;
  readonly state: string;
}): string {
  return `${input.code}${CONNECT_AUTH_CODE_SEPARATOR}${input.state}`;
}

export function checkConnectAuthCode(
  value: string,
  expectedState: string,
): { readonly code: string; readonly state: string } | string {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf(CONNECT_AUTH_CODE_SEPARATOR);
  if (separator <= 0 || separator === trimmed.length - 1) {
    return "That does not look like a T3 Connect code. Copy the full code.";
  }
  const code = trimmed.slice(0, separator);
  const state = trimmed.slice(separator + 1);
  if (state !== expectedState) {
    return "That code belongs to a different connect request. Open the URL above and try again.";
  }
  return { code, state };
}
