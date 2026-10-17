import { useAuth, useClerk } from "@clerk/react";
import { readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { useCallback, useEffect, useRef, useState } from "react";

import { buildConnectCliAuthorizeUrl, connectCliSignInRedirectUrl } from "../cloud/connectCliAuth";

/**
 * /connect: the URL the CLI prints for the loopback flow. Waits for a Clerk
 * session, then forwards the CLI's PKCE request to Clerk's authorize endpoint
 * with the loopback redirect URI so the code returns straight to the waiting
 * CLI. Headless hosts use Clerk's device authorization page instead.
 */
export function ConnectCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const [error, setError] = useState<string | null>(null);
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const signInOpened = useRef(false);
  const redirecting = useRef(false);

  const openSignIn = useCallback(() => {
    if (!request) return;
    const redirectUrl = connectCliSignInRedirectUrl(request, window.location.href);
    clerk.openSignIn({
      forceRedirectUrl: redirectUrl,
      signUpForceRedirectUrl: redirectUrl,
    });
  }, [clerk, request]);

  useEffect(() => {
    if (!request || !isLoaded || redirecting.current) return;
    if (!isSignedIn) {
      if (!signInOpened.current) {
        signInOpened.current = true;
        openSignIn();
      }
      return;
    }
    const url = buildConnectCliAuthorizeUrl(request);
    if (!url) {
      setError("T3 Connect authorization is not configured for this hosted app.");
      return;
    }
    redirecting.current = true;
    window.location.assign(url);
  }, [isLoaded, isSignedIn, openSignIn, request]);

  return (
    <main className="mx-auto mt-24 max-w-lg px-6 font-sans">
      <h1 className="text-2xl font-semibold">Connecting your terminal</h1>
      <p className="mt-3 text-muted-foreground">
        {error ??
          (request
            ? isSignedIn
              ? "Redirecting to authorize T3 Connect."
              : "Sign in to continue authorizing T3 Connect."
            : "This link is incomplete. Re-run `t3 connect` and open the new URL.")}
      </p>
      {request && isLoaded && !isSignedIn ? (
        <button
          className="mt-6 rounded border px-4 py-2 text-sm font-medium"
          type="button"
          onClick={openSignIn}
        >
          Sign in
        </button>
      ) : null}
    </main>
  );
}
