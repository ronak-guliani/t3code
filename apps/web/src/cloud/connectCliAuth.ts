import {
  buildConnectClerkAuthorizeUrl,
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
  DEFAULT_HOSTED_APP_URL,
  type ConnectAuthorizeRequest,
} from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import { isSecureRelayUrl } from "@t3tools/shared/relayUrl";

function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function isHostedConnectEnabled(): boolean {
  const hostedUrl = new URL(configuredHostedAppUrl());
  return Boolean(
    !trimNonEmpty(import.meta.env.VITE_HTTP_URL) &&
    new URL(window.location.href).origin === hostedUrl.origin &&
    resolveConnectCliAuthPublishableKey(),
  );
}

export function isConnectCliAuthEnabled(): boolean {
  return (
    isHostedConnectEnabled() &&
    Boolean(trimNonEmpty(import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID))
  );
}

export function isConnectAccountManagementEnabled(): boolean {
  return isHostedConnectEnabled() && isSecureRelayUrl(import.meta.env.VITE_T3CODE_RELAY_URL ?? "");
}

export function resolveConnectCliAuthPublishableKey(): string | null {
  return trimNonEmpty(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
}

function configuredHostedAppUrl(): string {
  return trimNonEmpty(import.meta.env.VITE_HOSTED_APP_URL) ?? DEFAULT_HOSTED_APP_URL;
}

export function connectAccountManagementUrl(): string {
  return new URL("/connect/environments", configuredHostedAppUrl()).href;
}

/**
 * Builds the Clerk authorize URL for a CLI-initiated connect request. The
 * authorization code returns to the CLI's `127.0.0.1` listener directly, so
 * this page never sees it. Clerk enforces its registered redirect URI
 * allowlist either way. Headless hosts use Clerk's device authorization
 * page instead and never involve this page.
 */
export function buildConnectCliAuthorizeUrl(request: ConnectAuthorizeRequest): string | null {
  const publishableKey = resolveConnectCliAuthPublishableKey();
  const clientId = trimNonEmpty(import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID);
  if (!publishableKey || !clientId) return null;
  return buildConnectClerkAuthorizeUrl({
    authorizationEndpoint: `${clerkFrontendApiUrlFromPublishableKey(publishableKey)}/oauth/authorize`,
    clientId,
    redirectUri: connectLoopbackRedirectUri(request.loopbackPort),
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
