import type { AdvertisedEndpoint, EnvironmentId } from "@t3tools/contracts";
import { formatSchemaError } from "@t3tools/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { fetchAuthenticatedRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError, RemoteEnvironmentAuthTimeoutError } from "../rpc/http.ts";
import { requestEnvironmentRead } from "../state/environmentHttpAuth.ts";
import type { ConnectionRouteKind, PreparedConnection } from "./model.ts";

const ENDPOINTS_REQUEST_TIMEOUT_MS = 10_000;
const CANDIDATE_PROBE_TIMEOUT_MS = 3_000;
const PROMOTION_FAILURE_COOLDOWN_MS = 5 * 60_000;
const PROMOTION_REDISCOVERY_INTERVAL_MS = 3 * 60_000;
const PROMOTION_REDISCOVERY_JITTER_MS = 15_000;
const MAX_CONCURRENT_PROBES = 8;

export interface PromotedRoute {
  readonly endpointId: string;
  readonly currentHttpBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly kind: Exclude<ConnectionRouteKind, "relay">;
}

export type ConnectionPromotionDiagnostic =
  | {
      readonly _tag: "unsupported";
      readonly status: 200 | 404;
      readonly detail: string;
    }
  | {
      readonly _tag: "unauthorized";
      readonly status: 401 | 403;
      readonly detail: string;
    }
  | {
      readonly _tag: "invalid-response";
      readonly status: number;
      readonly detail: string;
    }
  | {
      readonly _tag: "transport";
      readonly detail: string;
    };

export class ConnectionPromotionDiscoveryError extends Data.TaggedError(
  "ConnectionPromotionDiscoveryError",
)<{
  readonly diagnostic: ConnectionPromotionDiagnostic;
}> {}

const advertisedEndpoints = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    provider: Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      kind: Schema.Literals(["core", "private-network", "tunnel", "manual"]),
      isAddon: Schema.Boolean,
    }),
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
    reachability: Schema.Literals(["loopback", "lan", "private-network", "public"]),
    compatibility: Schema.Struct({
      hostedHttpsApp: Schema.Literals([
        "compatible",
        "mixed-content-blocked",
        "requires-configuration",
        "unknown",
      ]),
      desktopApp: Schema.Literals(["compatible", "unknown"]),
    }),
    source: Schema.Literals(["desktop-core", "desktop-addon", "server", "user"]),
    status: Schema.Literals(["available", "unavailable", "unknown"]),
    isDefault: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.String),
  }),
);
const decodeAdvertisedEndpoints = Schema.decodeUnknownEffect(advertisedEndpoints);

const reachabilityRank: Record<AdvertisedEndpoint["reachability"], number> = {
  lan: 0,
  "private-network": 1,
  loopback: 2,
  public: 3,
};

function normalizedBaseUrl(rawValue: string): string | null {
  try {
    const url = new URL(rawValue);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function routeKind(endpoint: AdvertisedEndpoint): Exclude<ConnectionRouteKind, "relay"> {
  return endpoint.id.startsWith("tailscale-") ||
    endpoint.provider.kind === "private-network" ||
    endpoint.reachability === "private-network"
    ? "tailscale"
    : "lan";
}

function secureTransportAllowed(
  currentHttpBaseUrl: string,
  candidateHttpBaseUrl: string,
  candidateWsBaseUrl: string,
): boolean {
  try {
    const current = new URL(currentHttpBaseUrl);
    const candidate = new URL(candidateHttpBaseUrl);
    const websocket = new URL(candidateWsBaseUrl);
    return (
      (candidate.protocol === "http:" || candidate.protocol === "https:") &&
      (websocket.protocol === "ws:" || websocket.protocol === "wss:") &&
      (current.protocol !== "https:" || candidate.protocol === "https:") &&
      (current.protocol !== "https:" || websocket.protocol === "wss:")
    );
  } catch {
    return false;
  }
}

export function selectPromotionCandidates(input: {
  readonly endpoints: readonly AdvertisedEndpoint[];
  readonly currentHttpBaseUrl: string;
  readonly cooldownEndpointIds?: ReadonlySet<string>;
}): readonly AdvertisedEndpoint[] {
  const currentBaseUrl = normalizedBaseUrl(input.currentHttpBaseUrl);
  return input.endpoints
    .filter((endpoint) => {
      if (endpoint.status === "unavailable") return false;
      if (endpoint.reachability !== "lan" && endpoint.reachability !== "private-network") {
        return false;
      }
      if (input.cooldownEndpointIds?.has(endpoint.id)) return false;
      if (normalizedBaseUrl(endpoint.httpBaseUrl) === currentBaseUrl) return false;
      return secureTransportAllowed(
        input.currentHttpBaseUrl,
        endpoint.httpBaseUrl,
        endpoint.wsBaseUrl,
      );
    })
    .sort(
      (left, right) => reachabilityRank[left.reachability] - reachabilityRank[right.reachability],
    );
}

export class ConnectionPromotion extends Context.Service<
  ConnectionPromotion,
  {
    readonly enabled: boolean;
    readonly overrideFor: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<PromotedRoute>>;
    readonly diagnosticFor: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<ConnectionPromotionDiagnostic>>;
    readonly reportOverrideFailed: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly clear: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly discover: (
      prepared: PreparedConnection,
    ) => Effect.Effect<Option.Option<PromotedRoute>>;
  }
>()("@t3tools/client-runtime/connection/promotion/ConnectionPromotion") {}

const fetchAdvertisedEndpoints = Effect.fn(
  "clientRuntime.connection.promotion.fetchAdvertisedEndpoints",
)(function* (
  prepared: PreparedConnection,
  signer: ManagedRelay.ManagedRelayDpopSigner["Service"],
  httpClient: HttpClient.HttpClient,
) {
  const requestUrl = environmentEndpointUrl(prepared.httpBaseUrl, "/api/remote-access/endpoints");
  const response = yield* requestEnvironmentRead(
    prepared.httpAuthorization,
    requestUrl,
    Option.some(signer),
    (headers) =>
      httpClient
        .execute(
          HttpClientRequest.get(requestUrl).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeaders({
              ...(headers.authorization === undefined
                ? {}
                : { authorization: headers.authorization }),
              ...(headers.dpop === undefined ? {} : { dpop: headers.dpop }),
            }),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new RemoteEnvironmentAuthFetchError({
                message: `Failed to fetch remote route discovery ${requestUrl}.`,
                cause,
              }),
          ),
          Effect.timeoutOption(Duration.millis(ENDPOINTS_REQUEST_TIMEOUT_MS)),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new RemoteEnvironmentAuthTimeoutError(requestUrl, ENDPOINTS_REQUEST_TIMEOUT_MS),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
  );

  if (response.status === 404) {
    return yield* new ConnectionPromotionDiscoveryError({
      diagnostic: {
        _tag: "unsupported",
        status: 404,
        detail: "This environment server does not support automatic route discovery.",
      },
    });
  }
  if (response.status === 401 || response.status === 403) {
    return yield* new ConnectionPromotionDiscoveryError({
      diagnostic: {
        _tag: "unauthorized",
        status: response.status,
        detail: "The current environment credential cannot read route discovery.",
      },
    });
  }
  if (response.status !== 200) {
    return yield* new ConnectionPromotionDiscoveryError({
      diagnostic: {
        _tag: "invalid-response",
        status: response.status,
        detail: `Route discovery returned HTTP ${response.status}.`,
      },
    });
  }

  const contentType = response.headers["content-type"] ?? "";
  const body = yield* response.json.pipe(
    Effect.mapError(
      () =>
        new ConnectionPromotionDiscoveryError({
          diagnostic: contentType.includes("text/html")
            ? {
                _tag: "unsupported",
                status: 404,
                detail:
                  "This environment server returned an older web app instead of route discovery.",
              }
            : {
                _tag: "invalid-response",
                status: 200,
                detail: "Route discovery returned unreadable JSON.",
              },
        }),
    ),
  );
  const decoded = yield* decodeAdvertisedEndpoints(body).pipe(Effect.result);
  if (Result.isFailure(decoded)) {
    return yield* new ConnectionPromotionDiscoveryError({
      diagnostic: {
        _tag: "invalid-response",
        status: 200,
        detail: `Route discovery returned an invalid endpoint list: ${formatSchemaError(Cause.fail(decoded.failure))}`,
      },
    });
  }
  return decoded.success as readonly AdvertisedEndpoint[];
});

export const make = Effect.gen(function* () {
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
  const httpClient = yield* HttpClient.HttpClient;
  const enabled = presentation.automaticRoutePromotion === true;
  const overrides = yield* Ref.make<ReadonlyMap<EnvironmentId, PromotedRoute>>(new Map());
  const cooldowns = yield* Ref.make<ReadonlyMap<EnvironmentId, ReadonlyMap<string, number>>>(
    new Map(),
  );
  const diagnostics = yield* Ref.make<ReadonlyMap<EnvironmentId, ConnectionPromotionDiagnostic>>(
    new Map(),
  );

  const overrideFor = (environmentId: EnvironmentId) =>
    Ref.get(overrides).pipe(
      Effect.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
    );

  const diagnosticFor = (environmentId: EnvironmentId) =>
    Ref.get(diagnostics).pipe(
      Effect.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
    );

  const recordDiagnostic = (
    environmentId: EnvironmentId,
    diagnostic: ConnectionPromotionDiagnostic,
  ) => Ref.update(diagnostics, (current) => new Map(current).set(environmentId, diagnostic));

  const clearDiagnostic = (environmentId: EnvironmentId) =>
    Ref.update(diagnostics, (current) => {
      if (!current.has(environmentId)) return current;
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });

  const reportOverrideFailed = Effect.fn("ConnectionPromotion.reportOverrideFailed")(function* (
    environmentId: EnvironmentId,
  ) {
    const override = (yield* Ref.get(overrides)).get(environmentId);
    if (override === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(overrides, (current) => {
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });
    yield* Ref.update(cooldowns, (current) => {
      const next = new Map(current);
      const forEnvironment = new Map(current.get(environmentId) ?? []);
      forEnvironment.set(override.endpointId, now);
      next.set(environmentId, forEnvironment);
      return next;
    });
  });

  const activeCooldownEndpointIds = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
    const current = (yield* Ref.get(cooldowns)).get(environmentId);
    if (current === undefined) return new Set<string>();
    const now = yield* Clock.currentTimeMillis;
    const active = new Map(
      [...current].filter(([, failedAt]) => failedAt + PROMOTION_FAILURE_COOLDOWN_MS > now),
    );

    yield* Ref.update(cooldowns, (all) => {
      const next = new Map(all);
      if (active.size === 0) next.delete(environmentId);
      else next.set(environmentId, active);
      return next;
    });
    return new Set(active.keys());
  });

  const clear = Effect.fn("ConnectionPromotion.clear")(function* (environmentId: EnvironmentId) {
    yield* Ref.update(overrides, (current) => {
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });
    yield* Ref.update(diagnostics, (current) => {
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });
    yield* Ref.update(cooldowns, (current) => {
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });
  });

  const probeCandidate = Effect.fnUntraced(function* (
    candidate: AdvertisedEndpoint,
    environmentId: EnvironmentId,
    prepared: PreparedConnection,
  ) {
    const authorization =
      prepared.httpAuthorization?._tag === "Dpop"
        ? { _tag: "Dpop" as const, accessToken: prepared.httpAuthorization.accessToken }
        : prepared.httpAuthorization;
    const descriptor = yield* fetchAuthenticatedRemoteEnvironmentDescriptor({
      httpBaseUrl: candidate.httpBaseUrl,
      authorization,
      signer: Option.some(signer),
      timeoutMs: CANDIDATE_PROBE_TIMEOUT_MS,
    });
    return descriptor.environmentId === environmentId;
  });

  const discover = Effect.fn("ConnectionPromotion.discover")(function* (
    prepared: PreparedConnection,
  ) {
    if (!enabled || prepared.target._tag !== "RelayConnectionTarget") {
      return Option.none<PromotedRoute>();
    }
    const endpoints = yield* fetchAdvertisedEndpoints(prepared, signer, httpClient).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const diagnostic =
            error instanceof ConnectionPromotionDiscoveryError
              ? error.diagnostic
              : {
                  _tag: "transport" as const,
                  detail: "Route discovery could not reach the current environment route.",
                };
          yield* recordDiagnostic(prepared.environmentId, diagnostic);
          yield* Effect.logDebug("Automatic route discovery did not produce candidates.", {
            environmentId: prepared.environmentId,
            diagnostic: diagnostic._tag,
          });
          return [] as readonly AdvertisedEndpoint[];
        }),
      ),
    );
    const candidates = selectPromotionCandidates({
      endpoints,
      currentHttpBaseUrl: prepared.httpBaseUrl,
      cooldownEndpointIds: yield* activeCooldownEndpointIds(prepared.environmentId),
    });
    if (candidates.length === 0) return Option.none<PromotedRoute>();

    const probed = yield* Effect.all(
      candidates.map((candidate) =>
        probeCandidate(candidate, prepared.environmentId, prepared).pipe(
          Effect.orElseSucceed(() => false),
        ),
      ),
      { concurrency: MAX_CONCURRENT_PROBES },
    );
    const selected = candidates.find((_, index) => probed[index] === true);
    if (selected === undefined) {
      yield* recordDiagnostic(prepared.environmentId, {
        _tag: "transport",
        detail: "No advertised direct route answered as the expected environment.",
      });
      return Option.none<PromotedRoute>();
    }

    const route: PromotedRoute = {
      endpointId: selected.id,
      currentHttpBaseUrl: prepared.httpBaseUrl,
      httpBaseUrl: selected.httpBaseUrl,
      wsBaseUrl: selected.wsBaseUrl,
      kind: routeKind(selected),
    };
    yield* Ref.update(overrides, (current) => new Map(current).set(prepared.environmentId, route));
    yield* clearDiagnostic(prepared.environmentId);
    return Option.some(route);
  });

  return ConnectionPromotion.of({
    enabled,
    overrideFor,
    diagnosticFor,
    reportOverrideFailed,
    clear,
    discover: (prepared) =>
      discover(prepared).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
  });
});

export const layer = Layer.effect(ConnectionPromotion, make);

export const promotionRediscoveryDelay = Effect.gen(function* () {
  const jitter = yield* Random.nextIntBetween(
    -PROMOTION_REDISCOVERY_JITTER_MS,
    PROMOTION_REDISCOVERY_JITTER_MS,
  );
  return Duration.millis(Math.max(1_000, PROMOTION_REDISCOVERY_INTERVAL_MS + jitter));
});
