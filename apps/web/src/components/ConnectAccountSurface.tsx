import { useAuth, useClerk } from "@clerk/react";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import {
  CONNECT_ACTION_HELP,
  CONNECT_CAPACITY_UNAVAILABLE,
  DEREGISTER_ENVIRONMENT_CONSEQUENCES,
} from "@t3tools/shared/connectManagement";
import { useEffect, useRef, useState } from "react";
import {
  deregisterAccountEnvironment,
  listAccountEnvironments,
} from "../cloud/accountEnvironments";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "./ui/alert-dialog";

async function accountCredentials(
  getToken: ReturnType<typeof useAuth>["getToken"],
  accountId: string,
  signal: AbortSignal,
) {
  const template = import.meta.env.VITE_CLERK_JWT_TEMPLATE?.trim();
  const token = await getToken(template ? { template } : undefined);
  signal.throwIfAborted();
  if (!token) throw new Error("Sign in again to manage T3 Connect environments.");
  return { accountId, token, relayUrl: import.meta.env.VITE_T3CODE_RELAY_URL ?? "", signal };
}

export function ConnectAccountSurface() {
  const { isLoaded, userId } = useAuth();
  const clerk = useClerk();
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <h1 className="text-2xl font-semibold">T3 Connect environments</h1>
      <p className="text-sm text-muted-foreground">{CONNECT_ACTION_HELP}</p>
      {!isLoaded ? (
        <p role="status">Loading account...</p>
      ) : userId ? (
        <AccountEnvironments key={userId} accountId={userId} />
      ) : (
        <Button onClick={() => clerk.openSignIn({ forceRedirectUrl: window.location.href })}>
          Sign in to manage environments
        </Button>
      )}
    </main>
  );
}

function AccountEnvironments({ accountId }: { readonly accountId: string }) {
  const { getToken } = useAuth();
  const [environments, setEnvironments] =
    useState<ReadonlyArray<RelayClientEnvironmentRecord> | null>(null);
  const [selected, setSelected] = useState<RelayClientEnvironmentRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const mutation = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setBusy(true);
      setError(null);
      try {
        const records = await listAccountEnvironments(
          await accountCredentials(getToken, accountId, controller.signal),
        );
        if (!controller.signal.aborted) setEnvironments(records);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Could not load account environments.");
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [getToken, accountId, revision]);

  const deregister = async () => {
    const signal = lifetime.current?.signal;
    if (!selected || !signal || mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError(null);
    try {
      await deregisterAccountEnvironment({
        ...(await accountCredentials(getToken, accountId, signal)),
        environmentId: selected.environmentId,
      });
      if (signal.aborted) return;
      setEnvironments(
        (current) =>
          current?.filter((entry) => entry.environmentId !== selected.environmentId) ?? null,
      );
      setSelected(null);
    } catch (cause) {
      if (!signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not deregister this environment.");
    } finally {
      mutation.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="break-all text-sm">Account: {accountId}</p>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setRevision((current) => current + 1)}
        >
          Refresh
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{CONNECT_CAPACITY_UNAVAILABLE}</p>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {busy ? <p role="status">Updating account environments...</p> : null}
      {environments?.length === 0 ? <p>No account registrations.</p> : null}
      {environments?.map((environment) => (
        <article key={environment.environmentId} className="space-y-2 rounded-lg border p-4">
          <h2 className="font-medium">{environment.label}</h2>
          <p className="break-all font-mono text-xs">{environment.environmentId}</p>
          <p className="text-xs text-muted-foreground">Registered: {environment.linkedAt}</p>
          <p className="break-all text-xs text-muted-foreground">
            {environment.endpoint.httpBaseUrl}
          </p>
          <p className="text-xs text-muted-foreground">
            Last seen, installation type, and build are not reported by this relay. Registration age
            does not prove this host is stale.
          </p>
          <Button
            variant="destructive-outline"
            disabled={busy}
            onClick={() => setSelected(environment)}
          >
            Deregister
          </Button>
        </article>
      ))}
      <AlertDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Deregister {selected?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="mb-3 block break-all font-mono text-xs">
                {selected?.environmentId}
              </span>
              {DEREGISTER_ENVIRONMENT_CONSEQUENCES}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="px-6 pb-4 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setSelected(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void deregister()}>
              Deregister from account
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
