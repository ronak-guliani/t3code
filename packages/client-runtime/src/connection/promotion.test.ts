import { AuthStandardClientScopes, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";

import * as ConnectionPromotion from "./promotion.ts";
import { selectPromotionCandidates } from "./promotion.ts";
import { RelayConnectionTarget, type PreparedConnection } from "./model.ts";

const environmentId = EnvironmentId.make("environment-promotion-test");

function endpoint(
  overrides: Partial<{
    id: string;
    httpBaseUrl: string;
    wsBaseUrl: string;
    reachability: "lan" | "private-network" | "loopback" | "public";
    status: "available" | "unavailable" | "unknown";
    providerKind: "core" | "private-network" | "tunnel" | "manual";
  }> = {},
) {
  return {
    id: overrides.id ?? "lan-main",
    label: "Environment",
    provider: {
      id: "provider",
      label: "Provider",
      kind: overrides.providerKind ?? "core",
      isAddon: false,
    },
    httpBaseUrl: overrides.httpBaseUrl ?? "https://192.168.1.20:3773",
    wsBaseUrl: overrides.wsBaseUrl ?? "wss://192.168.1.20:3773/ws",
    reachability: overrides.reachability ?? "lan",
    compatibility: {
      hostedHttpsApp: "compatible" as const,
      desktopApp: "compatible" as const,
    },
    source: "server" as const,
    status: overrides.status ?? "available",
    environmentId,
  };
}

describe("selectPromotionCandidates", () => {
  it("prefers LAN over private-network endpoints and removes duplicates by route", () => {
    const candidates = selectPromotionCandidates({
      currentHttpBaseUrl: "https://relay.example.test",
      endpoints: [
        endpoint({
          id: "tailscale",
          reachability: "private-network",
          providerKind: "private-network",
          httpBaseUrl: "https://host.tailnet.ts.net",
          wsBaseUrl: "wss://host.tailnet.ts.net/ws",
        }),
        endpoint({
          id: "lan",
          httpBaseUrl: "https://192.168.1.20:3773",
          wsBaseUrl: "wss://192.168.1.20:3773/ws",
        }),
      ],
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["lan", "tailscale"]);
  });

  it("rejects public, loopback, unavailable, duplicate-current, and HTTPS downgrade candidates", () => {
    const candidates = selectPromotionCandidates({
      currentHttpBaseUrl: "https://relay.example.test",
      endpoints: [
        endpoint({ id: "public", reachability: "public" }),
        endpoint({ id: "loopback", reachability: "loopback" }),
        endpoint({ id: "unavailable", status: "unavailable" }),
        endpoint({
          id: "current",
          httpBaseUrl: "https://relay.example.test",
          wsBaseUrl: "wss://relay.example.test/ws",
        }),
        endpoint({
          id: "plaintext",
          httpBaseUrl: "http://192.168.1.20:3773",
          wsBaseUrl: "ws://192.168.1.20:3773/ws",
        }),
        endpoint({
          id: "plaintext-websocket",
          httpBaseUrl: "https://192.168.1.21:3773",
          wsBaseUrl: "ws://192.168.1.21:3773/ws",
        }),
      ],
    });

    expect(candidates).toEqual([]);
  });

  it("honors endpoint cooldowns without suppressing other candidates", () => {
    const candidates = selectPromotionCandidates({
      currentHttpBaseUrl: "http://relay.example.test",
      cooldownEndpointIds: new Set(["lan"]),
      endpoints: [
        endpoint({ id: "lan" }),
        endpoint({
          id: "tailscale",
          reachability: "private-network",
          providerKind: "private-network",
          httpBaseUrl: "https://host.tailnet.ts.net",
          wsBaseUrl: "wss://host.tailnet.ts.net/ws",
        }),
      ],
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["tailscale"]);
  });
});

const preparedRelay: PreparedConnection = {
  environmentId,
  label: "Environment",
  httpBaseUrl: "https://relay.example.test",
  socketUrl: "wss://relay.example.test/ws",
  httpAuthorization: { _tag: "Dpop", accessToken: "relay-token" },
  target: new RelayConnectionTarget({
    environmentId,
    label: "Environment",
  }),
  routeKind: "relay",
};

const makeAdvertisedEndpoint = (
  id: string,
  httpBaseUrl: string,
  reachability: "lan" | "private-network",
) => ({
  id,
  label: id,
  provider: {
    id: `${id}-provider`,
    label: id,
    kind: reachability === "private-network" ? ("private-network" as const) : ("core" as const),
    isAddon: false,
  },
  httpBaseUrl,
  wsBaseUrl: httpBaseUrl.replace("https://", "wss://") + "/ws",
  reachability,
  compatibility: {
    hostedHttpsApp: "compatible" as const,
    desktopApp: "compatible" as const,
  },
  source: "server" as const,
  status: "available" as const,
});

const descriptor = {
  environmentId,
  label: "Environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};

function promotionLayer(fetchFn: typeof fetch) {
  return ConnectionPromotion.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        remoteHttpClientLayer(fetchFn),
        Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, {
          thumbprint: Effect.succeed("thumbprint"),
          createProof: () => Effect.succeed("proof"),
        }),
        Layer.succeed(
          ClientCapabilities.ClientPresentation,
          ClientCapabilities.ClientPresentation.of({
            metadata: { label: "Test", deviceType: "mobile", os: "test" },
            scopes: AuthStandardClientScopes,
            automaticRoutePromotion: true,
          }),
        ),
      ),
    ),
  );
}

describe("ConnectionPromotion", () => {
  it.effect("rejects contract-invalid discovery fields before probing or storing overrides", () =>
    Effect.gen(function* () {
      const valid = endpoint();
      for (const invalid of [
        { ...valid, id: " " },
        { ...valid, label: "" },
        { ...valid, httpBaseUrl: " " },
        { ...valid, wsBaseUrl: "" },
        { ...valid, description: " " },
        { ...valid, provider: { ...valid.provider, id: "" } },
        { ...valid, provider: { ...valid.provider, label: " " } },
      ]) {
        let requests = 0;
        const fetchFn = (() => {
          requests += 1;
          return Promise.resolve(Response.json(requests === 1 ? [invalid] : descriptor));
        }) satisfies typeof fetch;
        yield* Effect.gen(function* () {
          const promotion = yield* ConnectionPromotion.ConnectionPromotion;
          expect(yield* promotion.discover(preparedRelay)).toEqual(Option.none());
          expect(yield* promotion.overrideFor(environmentId)).toEqual(Option.none());
          expect(Option.getOrThrow(yield* promotion.diagnosticFor(environmentId))).toMatchObject({
            _tag: "invalid-response",
            status: 200,
          });
          expect(requests).toBe(1);
        }).pipe(Effect.provide(promotionLayer(fetchFn)));
      }
    }),
  );

  it.effect("classifies core private-network endpoints independently of their provider", () =>
    Effect.gen(function* () {
      for (const candidate of [
        endpoint({
          id: "server-private-network:http://100.64.0.4:3773",
          httpBaseUrl: "http://100.64.0.4:3773",
          wsBaseUrl: "ws://100.64.0.4:3773",
          reachability: "private-network",
        }),
        endpoint({ id: "server-lan:https://192.168.1.20:3773" }),
      ]) {
        const requests: string[] = [];
        const fetchFn = ((url) => {
          requests.push(String(url));
          return Promise.resolve(Response.json(requests.length === 1 ? [candidate] : descriptor));
        }) satisfies typeof fetch;
        yield* Effect.gen(function* () {
          const promotion = yield* ConnectionPromotion.ConnectionPromotion;
          const route = yield* promotion.discover({
            ...preparedRelay,
            httpBaseUrl: "http://relay.example.test",
          });
          expect(Option.getOrThrow(route).kind).toBe(
            candidate.reachability === "private-network" ? "tailscale" : "lan",
          );
          expect(yield* promotion.overrideFor(environmentId)).toEqual(route);
        }).pipe(Effect.provide(promotionLayer(fetchFn)));
        expect(requests).toHaveLength(2);
      }
    }),
  );

  it.effect("discovers candidates and cools down only the failed endpoint", () =>
    Effect.gen(function* () {
      const lan = makeAdvertisedEndpoint("lan", "https://192.168.1.20:3773", "lan");
      const tailscale = makeAdvertisedEndpoint(
        "tailscale",
        "https://host.tailnet.ts.net",
        "private-network",
      );
      const responses = [
        Response.json([lan, tailscale]),
        Response.json(descriptor),
        Response.json(descriptor),
        Response.json([lan, tailscale]),
        Response.json(descriptor),
      ];
      let index = 0;
      const fetchFn = ((input, _init) => {
        const response = responses[index++];
        if (response === undefined) {
          return Promise.reject(new Error(`Unexpected request ${String(input)}`));
        }
        return Promise.resolve(response);
      }) satisfies typeof fetch;

      const result = yield* Effect.gen(function* () {
        const promotion = yield* ConnectionPromotion.ConnectionPromotion;
        const first = yield* promotion.discover(preparedRelay);
        expect(Option.getOrThrow(first).endpointId).toBe("lan");

        yield* promotion.reportOverrideFailed(environmentId);
        const second = yield* promotion.discover(preparedRelay);
        return Option.getOrThrow(second);
      }).pipe(Effect.provide(promotionLayer(fetchFn)));

      expect(result.endpointId).toBe("tailscale");
      expect(index).toBe(5);
    }),
  );

  it.effect("classifies a 404 old server as unsupported without replacing the relay", () =>
    Effect.gen(function* () {
      const fetchFn = (() =>
        Promise.resolve(
          new Response("<html>old app</html>", {
            status: 404,
            headers: { "content-type": "text/html" },
          }),
        )) satisfies typeof fetch;

      const diagnostic = yield* Effect.gen(function* () {
        const promotion = yield* ConnectionPromotion.ConnectionPromotion;
        const discovered = yield* promotion.discover(preparedRelay);
        expect(Option.isNone(discovered)).toBe(true);
        return yield* promotion.diagnosticFor(environmentId);
      }).pipe(Effect.provide(promotionLayer(fetchFn)));

      expect(Option.getOrThrow(diagnostic)).toEqual({
        _tag: "unsupported",
        status: 404,
        detail: "This environment server does not support automatic route discovery.",
      });
    }),
  );
});
