import {
  ExecutionEnvironmentDescriptor,
  type RemoteAccessSetup,
  type RemoteAccessStatus,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Ref, Semaphore } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ManagedEndpointRuntime from "../cloud/ManagedEndpointRuntime.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import {
  normalizeRemoteAccessUrl,
  readRemoteAccessConfig,
  RemoteAccessError,
  writeRemoteAccessConfig,
} from "./config.ts";

export class RemoteAccess extends Context.Service<
  RemoteAccess,
  {
    readonly getStatus: Effect.Effect<RemoteAccessStatus>;
    readonly setup: (
      input: RemoteAccessSetup,
    ) => Effect.Effect<RemoteAccessStatus, RemoteAccessError>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<RemoteAccessStatus, RemoteAccessError>;
    readonly verify: Effect.Effect<string, RemoteAccessError>;
  }
>()("t3/remoteAccess") {}

const disabled: RemoteAccessStatus = {
  enabled: false,
  publicUrl: null,
  status: "disabled",
  message: "Remote Access is disabled.",
  checkedAt: null,
};

export const verifyRemoteAccessEndpoint = (publicUrl: string, environmentId: string) =>
  Effect.gen(function* () {
    const descriptor = yield* HttpClient.get(`${publicUrl}/.well-known/t3/environment`).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", cache: "no-store" }),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.timeout("5 seconds"),
      Effect.mapError(
        () =>
          new RemoteAccessError({
            message:
              "The public endpoint is unreachable. Check the tunnel, DNS, and its local service target.",
          }),
      ),
    );
    if (descriptor.environmentId !== environmentId) {
      return yield* new RemoteAccessError({
        message:
          "The hostname points to a different T3 environment. Fix the tunnel's service target before pairing.",
      });
    }
    return publicUrl;
  });

export const makeRemoteAccess = (
  connector: ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"],
) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    const environment = yield* ServerEnvironment;
    const client = yield* HttpClient.HttpClient;
    const lock = yield* Semaphore.make(1);
    const status = yield* Ref.make<RemoteAccessStatus>(disabled);

    const environmentId = yield* environment.getEnvironmentId;
    const probe = (publicUrl: string) =>
      verifyRemoteAccessEndpoint(publicUrl, environmentId).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

    const reconcile = lock
      .withPermits(1)(
        Effect.gen(function* () {
          const config = yield* readRemoteAccessConfig(secrets).pipe(
            Effect.tapError(() => connector.applyConfig(null)),
          );
          if (!config?.enabled) {
            const stopped = yield* connector.applyConfig(null);
            if (stopped.status === "failed") {
              return yield* new RemoteAccessError({
                message: "Could not stop the tunnel. Retry Disable or stop the host service.",
              });
            }
            yield* Ref.set(status, { ...disabled, publicUrl: config?.publicUrl ?? null });
            return;
          }
          yield* Ref.update(status, (previous) => ({
            ...previous,
            enabled: true,
            publicUrl: config.publicUrl,
            status: previous.status === "disabled" ? "starting" : previous.status,
            message: previous.status === "disabled" ? "Starting the tunnel." : previous.message,
          }));
          const runtime = yield* connector.applyConfig({
            providerKind: "cloudflare_tunnel",
            connectorToken: config.connectorToken,
          });
          if (runtime.status === "failed" || runtime.status === "unsupported") {
            return yield* new RemoteAccessError({
              message:
                "The tunnel connector could not start. Check the host logs and tunnel token.",
            });
          }
          const result = yield* Effect.result(probe(config.publicUrl));
          yield* Ref.set(status, {
            enabled: true,
            publicUrl: config.publicUrl,
            status: result._tag === "Success" ? "ready" : "unreachable",
            message:
              result._tag === "Success"
                ? "Ready to pair. Keep this host awake and online."
                : result.failure.message,
            checkedAt: new Date().toISOString(),
          });
        }),
      )
      .pipe(
        Effect.catchTag("RemoteAccessError", (error) =>
          Ref.update(status, (previous) => ({
            ...previous,
            status: "error" as const,
            message: error.message,
          })).pipe(Effect.andThen(Effect.logWarning(error.message))),
        ),
      );

    const setup = (input: RemoteAccessSetup) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const publicUrl = yield* Effect.try({
            try: () => normalizeRemoteAccessUrl(input.publicUrl),
            catch: () =>
              new RemoteAccessError({
                message:
                  "Use a permanent public HTTPS hostname without a port, path, or credentials.",
              }),
          });
          const connectorToken = input.connectorToken.trim();
          if (!connectorToken || /\s/.test(connectorToken)) {
            return yield* new RemoteAccessError({
              message: "Enter only the Cloudflare tunnel token, not the installation command.",
            });
          }
          yield* writeRemoteAccessConfig(secrets, { publicUrl, connectorToken, enabled: true });
          const next: RemoteAccessStatus = {
            enabled: true,
            publicUrl,
            status: "starting",
            message: "Configuration saved. Starting and verifying the tunnel.",
            checkedAt: null,
          };
          yield* Ref.set(status, next);
          return next;
        }),
      );

    const setEnabled = (enabled: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const config = yield* readRemoteAccessConfig(secrets);
          if (!config) {
            return yield* new RemoteAccessError({
              message: "Configure a tunnel with `t3 remote setup` first.",
            });
          }
          // Persist desired state before stopping, so a crash cannot re-enable exposure.
          yield* writeRemoteAccessConfig(secrets, { ...config, enabled });
          const next: RemoteAccessStatus = {
            ...disabled,
            enabled,
            publicUrl: config.publicUrl,
            status: enabled ? "starting" : "disabled",
            message: enabled ? "Starting and verifying the tunnel." : disabled.message,
          };
          yield* Ref.set(status, next);
          if (!enabled) {
            const stopped = yield* connector.applyConfig(null);
            if (stopped.status === "failed") {
              const message =
                "Disable saved, but the connector could not stop. Retry Disable or stop the host service.";
              yield* Ref.set(status, { ...next, status: "error" as const, message });
              return yield* new RemoteAccessError({ message });
            }
          }
          return next;
        }),
      );

    const verify = lock.withPermits(1)(
      Effect.gen(function* () {
        const config = yield* readRemoteAccessConfig(secrets);
        if (!config?.enabled)
          return yield* new RemoteAccessError({ message: "Enable Remote Access before pairing." });
        return yield* probe(config.publicUrl);
      }),
    );

    yield* Effect.forkScoped(
      Effect.forever(reconcile.pipe(Effect.andThen(Effect.sleep("10 seconds")))),
    );
    const getStatus = Effect.gen(function* () {
      const current = yield* Ref.get(status);
      if (current.status !== "ready") return current;
      const runtime = yield* connector.getStatus;
      return runtime.status === "running"
        ? current
        : {
            ...current,
            status: "starting" as const,
            message: "The tunnel is reconnecting.",
          };
    });
    return RemoteAccess.of({ getStatus, setup, setEnabled, verify });
  });

// Own a separate connector instance: managed Connect must not stop or replace this tunnel.
export const make = Effect.flatMap(ManagedEndpointRuntime.make, makeRemoteAccess);
export const layer = Layer.effect(RemoteAccess, make);
