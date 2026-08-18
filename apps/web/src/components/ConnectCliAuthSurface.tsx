import { useAuth, useClerk } from "@clerk/react";
import { encodeConnectAuthCode, readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildConnectCliAuthorizeUrl,
  connectCliAuthStorageError,
  prepareConnectCliSignIn,
  readConnectCliAuthState,
  storeConnectCliCallbackState,
} from "../cloud/connectCliAuth";

export function ConnectCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const [error, setError] = useState<string | null>(null);
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const signInOpened = useRef(false);
  const redirecting = useRef(false);

  const openSignIn = useCallback(() => {
    if (!request) return;
    const signIn = prepareConnectCliSignIn(request, window.location.href);
    if (!signIn) {
      setError(connectCliAuthStorageError);
      return;
    }
    clerk.openSignIn(signIn);
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
    if (!storeConnectCliCallbackState(request)) {
      setError(connectCliAuthStorageError);
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

export function ConnectCliCallbackSurface() {
  const [result] = useState(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code")?.trim() ?? "";
    const state = url.searchParams.get("state")?.trim() ?? "";
    return code && state ? { code, state } : null;
  });
  const [expectedState] = useState(readConnectCliAuthState);

  const valid = result !== null && expectedState !== null && result.state === expectedState;
  const code = valid && result ? encodeConnectAuthCode(result) : null;

  return (
    <main className="mx-auto mt-24 max-w-lg px-6 font-sans">
      <h1 className="text-2xl font-semibold">
        {code ? "Almost connected" : "Authorization did not complete"}
      </h1>
      <p className="mt-3 text-muted-foreground">
        {code
          ? "Copy this one-time code into the terminal that started T3 Connect."
          : "This callback is invalid, expired, or belongs to a different request. Re-run `t3 connect` and try again."}
      </p>
      {code ? (
        <code className="mt-6 block break-all rounded border p-4 font-mono text-sm select-all">
          {code}
        </code>
      ) : null}
    </main>
  );
}
