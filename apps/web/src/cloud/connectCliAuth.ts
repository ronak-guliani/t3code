import {
  buildConnectClerkAuthorizeUrl,
  connectCallbackUrl,
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
  DEFAULT_HOSTED_APP_URL,
  type ConnectAuthorizeRequest,
} from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";

const stateStorageKey = "t3code-connect-cli-auth-state";

function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

export function isConnectCliAuthEnabled(): boolean {
  const hostedUrl = new URL(configuredHostedAppUrl());
  return Boolean(
    !trimNonEmpty(import.meta.env.VITE_HTTP_URL) &&
    new URL(window.location.href).origin === hostedUrl.origin &&
    resolveConnectCliAuthPublishableKey() &&
    trimNonEmpty(import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID),
  );
}

export function resolveConnectCliAuthPublishableKey(): string | null {
  return trimNonEmpty(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
}

function configuredHostedAppUrl(): string {
  return trimNonEmpty(import.meta.env.VITE_HOSTED_APP_URL) ?? DEFAULT_HOSTED_APP_URL;
}

export function buildConnectCliAuthorizeUrl(request: ConnectAuthorizeRequest): string | null {
  const publishableKey = resolveConnectCliAuthPublishableKey();
  const clientId = trimNonEmpty(import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID);
  if (!publishableKey || !clientId) return null;
  return buildConnectClerkAuthorizeUrl({
    authorizationEndpoint: `${clerkFrontendApiUrlFromPublishableKey(publishableKey)}/oauth/authorize`,
    clientId,
    redirectUri:
      request.loopbackPort === undefined
        ? connectCallbackUrl(configuredHostedAppUrl())
        : connectLoopbackRedirectUri(request.loopbackPort),
    scopes: CONNECT_OAUTH_SCOPES,
    state: request.state,
    challenge: request.challenge,
  });
}

export function connectCliSignInRedirectUrl(
  request: ConnectAuthorizeRequest,
  fallbackUrl: string,
): string {
  return buildConnectCliAuthorizeUrl(request) ?? fallbackUrl;
}

export function prepareConnectCliSignIn(
  request: ConnectAuthorizeRequest,
  fallbackUrl: string,
): {
  readonly forceRedirectUrl: string;
  readonly signUpForceRedirectUrl: string;
} {
  rememberConnectCliAuthState(request.state);
  const redirectUrl = connectCliSignInRedirectUrl(request, fallbackUrl);
  return {
    forceRedirectUrl: redirectUrl,
    signUpForceRedirectUrl: redirectUrl,
  };
}

export function rememberConnectCliAuthState(state: string): void {
  try {
    window.sessionStorage.setItem(stateStorageKey, state);
  } catch {
    // The callback will reject if storage is unavailable.
  }
}

export function readConnectCliAuthState(): string | null {
  try {
    return window.sessionStorage.getItem(stateStorageKey);
  } catch {
    return null;
  }
}
