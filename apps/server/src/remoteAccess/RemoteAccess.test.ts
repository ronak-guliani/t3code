import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { Deferred, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore, SecretStorePersistError } from "../auth/ServerSecretStore.ts";
import type { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { makeRemoteAccess } from "./RemoteAccess.ts";
import {
  normalizeRemoteAccessUrl,
  REMOTE_ACCESS_CONFIG,
  type RemoteAccessConfig,
} from "./config.ts";

const config: RemoteAccessConfig = {
  enabled: true,
  publicUrl: "https://mac.example.com",
  connectorToken: "private-tunnel-token",
};

const fixture = (initial: RemoteAccessConfig | null = null) =>
  Effect.gen(function* () {
    let saved = initial ? JSON.stringify(initial) : null;
    let writable = true;
    let stopFails = false;
    let available = true;
    let remoteId = "host-a";
    const applied: Array<string | null> = [];
    const probed = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const connector: CloudManagedEndpointRuntime["Service"] = {
      getStatus: Effect.succeed({ status: "running", providerKind: "cloudflare_tunnel", pid: 123 }),
      applyConfig: (next) =>
        Effect.gen(function* () {
          applied.push(next?.connectorToken ?? null);
          if (!next) {
            yield* Deferred.succeed(stopped, undefined);
            return stopFails
              ? { status: "failed", providerKind: "cloudflare_tunnel", reason: "stop failed" }
              : { status: "disabled" };
          }
          return { status: "running", providerKind: "cloudflare_tunnel", pid: 123 };
        }),
    };
    const dependencies = Layer.mergeAll(
      Layer.mock(ServerSecretStore)({
        get: (name) =>
          Effect.sync(() => {
            expect(name).toBe(REMOTE_ACCESS_CONFIG);
            return saved === null ? Option.none() : Option.some(new TextEncoder().encode(saved));
          }),
        set: (name, bytes) =>
          Effect.gen(function* () {
            expect(name).toBe(REMOTE_ACCESS_CONFIG);
            if (!writable) return yield* new SecretStorePersistError({ resource: name });
            saved = new TextDecoder().decode(bytes);
          }),
      }),
      Layer.mock(ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("host-a")),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            expect(request.headers.authorization).toBeUndefined();
            expect(request.url).toBe("https://mac.example.com/.well-known/t3/environment");
            yield* Deferred.succeed(probed, undefined);
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                {
                  environmentId: remoteId,
                  label: "Mac",
                  platform: { os: "darwin", arch: "arm64" },
                  serverVersion: "0.0.0",
                  capabilities: {},
                },
                { status: available ? 200 : 503 },
              ),
            );
          }),
        ),
      ),
    );
    const remote = yield* makeRemoteAccess(connector).pipe(Effect.provide(dependencies));
    return {
      remote,
      applied,
      probed: Deferred.await(probed),
      stopped: Deferred.await(stopped),
      read: () => saved,
      corrupt: () => {
        saved = "not-json";
      },
      denyWrites: () => {
        writable = false;
      },
      failStop: () => {
        stopFails = true;
      },
      setAvailable: (value: boolean) => {
        available = value;
      },
      setRemoteId: (value: string) => {
        remoteId = value;
      },
    };
  });

describe("owned Remote Access", () => {
  it("accepts only permanent HTTPS origins", () => {
    expect(normalizeRemoteAccessUrl("https://Mac.example.com/")).toBe("https://mac.example.com");
    for (const value of [
      "http://mac.example.com",
      "https://127.0.0.1",
      "https://[::1]",
      "https://localhost",
      "https://mac.local",
      "https://mac.localhost",
      "https://mac.example.com:8443",
      "https://user:password@mac.example.com",
      "https://mac.example.com/path",
      "https://mac.example.com?token=secret",
      "https://mac.example.com#secret",
      "https://temporary.trycloudflare.com",
    ])
      expect(() => normalizeRemoteAccessUrl(value)).toThrow();
  });

  it.effect(
    "does not launch anything until configured; persists setup without returning its token",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.stopped;
        expect(f.applied).toEqual([null]);
        const status = yield* f.remote.setup(config);
        expect(status).toMatchObject({
          enabled: true,
          status: "starting",
          publicUrl: config.publicUrl,
        });
        expect(JSON.stringify(status)).not.toContain(config.connectorToken);
        expect(JSON.parse(f.read()!)).toEqual(config);
        yield* TestClock.adjust("10 seconds");
        expect(yield* f.remote.getStatus).toMatchObject({ status: "ready" });
        expect(f.applied).toEqual([null, config.connectorToken]);
      }),
  );

  it.effect("restores the tunnel on startup and recovers from endpoint outages", () =>
    Effect.gen(function* () {
      const f = yield* fixture(config);
      yield* f.probed;
      yield* Effect.yieldNow;
      expect(yield* f.remote.getStatus).toMatchObject({ status: "ready" });
      f.setAvailable(false);
      yield* TestClock.adjust("10 seconds");
      expect(yield* f.remote.getStatus).toMatchObject({ status: "unreachable", enabled: true });
      f.setAvailable(true);
      yield* TestClock.adjust("10 seconds");
      expect(yield* f.remote.getStatus).toMatchObject({ status: "ready" });
    }),
  );

  it.effect("refuses pairing with a wrong environment or disabled tunnel", () =>
    Effect.gen(function* () {
      const f = yield* fixture(config);
      yield* f.probed;
      f.setRemoteId("host-b");
      const mismatch = yield* Effect.flip(f.remote.verify);
      expect(mismatch.message).toContain("different T3 environment");
      yield* f.remote.setEnabled(false);
      expect((yield* Effect.flip(f.remote.verify)).message).toContain("Enable Remote Access");
      yield* TestClock.adjust("10 seconds");
      expect(f.applied.at(-1)).toBeNull();
      expect(JSON.parse(f.read()!).enabled).toBe(false);
    }),
  );

  it.effect("does not report a successful update if persistence fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.stopped;
      f.denyWrites();
      expect((yield* Effect.flip(f.remote.setup(config))).message).toContain("persist");
      expect(f.read()).toBeNull();
      expect(yield* f.remote.getStatus).toMatchObject({ enabled: false });
    }),
  );

  it.effect("persists disabled intent and surfaces failed connector teardown", () =>
    Effect.gen(function* () {
      const f = yield* fixture(config);
      yield* f.probed;
      f.failStop();
      expect((yield* Effect.flip(f.remote.setEnabled(false))).message).toContain("could not stop");
      expect(JSON.parse(f.read()!).enabled).toBe(false);
      expect(yield* f.remote.getStatus).toMatchObject({ enabled: false, status: "error" });
    }),
  );

  it.effect("stops exposure when stored configuration is unreadable", () =>
    Effect.gen(function* () {
      const f = yield* fixture(config);
      yield* f.probed;
      f.corrupt();
      yield* TestClock.adjust("10 seconds");
      expect(f.applied.at(-1)).toBeNull();
      expect(yield* f.remote.getStatus).toMatchObject({ status: "error" });
    }),
  );
});
