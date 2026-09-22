import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  ExecutionEnvironmentDescriptor,
  type AdvertisedEndpoint,
  type AdvertisedEndpointProvider,
} from "@t3tools/contracts";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import {
  resolveTailscaleAdvertisedEndpoints,
  type TailscaleNetworkInterfaces,
} from "@t3tools/tailscale";
import {
  buildTailscaleHttpsBaseUrl,
  readTailscaleServeMappings,
  readTailscaleStatus,
  type TailscaleServeMapping,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpServer } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "../startupAccess.ts";

const SERVER_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "server-core",
  label: "Server",
  kind: "core",
  isAddon: false,
};

const ENDPOINT_CACHE_TTL = "60 seconds";

type AddressFamily = "IPv4" | "IPv6";

export interface LiveListener {
  readonly host: string;
  readonly family: AddressFamily;
  readonly port: number;
}

export interface ResolveServerAdvertisedEndpointsInput {
  readonly listener: LiveListener;
  readonly networkInterfaces: TailscaleNetworkInterfaces;
  readonly tailscaleEndpoints?: readonly AdvertisedEndpoint[];
}

const normalizeHost = (host: string): string =>
  host
    .replace(/^\[|\]$/gu, "")
    .trim()
    .toLowerCase();

const listenerFamily = (host: string): AddressFamily | null => {
  const normalized = normalizeHost(host);
  if (normalized === "0.0.0.0" || NodeNet.isIP(normalized) === 4) return "IPv4";
  if (normalized === "::" || NodeNet.isIP(normalized) === 6) return "IPv6";
  return null;
};

const isIpv4Private = (address: string): boolean => {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [first, second] = parts as [number, number, number, number];
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  );
};

const isUsableIpv4 = (address: string): boolean => {
  if (NodeNet.isIP(address) !== 4) return false;
  const [first, second] = address.split(".").map(Number) as [number, number];
  return first !== 0 && first !== 127 && !(first === 169 && second === 254) && first < 224;
};

const isUsableIpv6 = (address: string): boolean => {
  const normalized = normalizeHost(address);
  if (NodeNet.isIP(normalized) !== 6) return false;
  return (
    normalized !== "::" &&
    normalized !== "::1" &&
    !normalized.startsWith("fe8") &&
    !normalized.startsWith("fe9") &&
    !normalized.startsWith("fea") &&
    !normalized.startsWith("feb") &&
    !normalized.startsWith("ff")
  );
};

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;
const isIpv6Family = (family: string | number): boolean => family === "IPv6" || family === 6;

const isUsableInterfaceAddress = (
  address: {
    readonly address: string;
    readonly family: string | number;
    readonly internal: boolean;
  },
  family: AddressFamily,
): boolean =>
  !address.internal &&
  (family === "IPv4"
    ? isIpv4Family(address.family) && isUsableIpv4(address.address)
    : isIpv6Family(address.family) && isUsableIpv6(address.address));

const endpointForAddress = (input: {
  readonly address: string;
  readonly port: number;
  readonly reachability: "lan" | "private-network" | "public";
  readonly label: string;
  readonly isDefault?: boolean;
}): AdvertisedEndpoint =>
  createAdvertisedEndpoint({
    provider: SERVER_ENDPOINT_PROVIDER,
    source: "server",
    id: `server-${input.reachability}:http://${formatHostForUrl(input.address)}:${input.port}`,
    label: input.label,
    httpBaseUrl: `http://${formatHostForUrl(input.address)}:${input.port}`,
    reachability: input.reachability,
    status: "available",
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
  });

const reachabilityForAddress = (
  address: string,
): { readonly reachability: "lan" | "private-network" | "public"; readonly label: string } => {
  if (isIpv4Private(address)) {
    return address.startsWith("100.") &&
      Number.parseInt(address.split(".")[1] ?? "", 10) >= 64 &&
      Number.parseInt(address.split(".")[1] ?? "", 10) <= 127
      ? { reachability: "private-network", label: "Private network" }
      : { reachability: "lan", label: "Local network" };
  }
  if (normalizeHost(address).startsWith("fc") || normalizeHost(address).startsWith("fd")) {
    return { reachability: "lan", label: "Local network" };
  }
  return { reachability: "public", label: "Public IP" };
};

const isUsableSpecificListener = (listener: LiveListener): boolean =>
  listener.family === "IPv4" ? isUsableIpv4(listener.host) : isUsableIpv6(listener.host);

const resolveCoreEndpoints = (
  input: ResolveServerAdvertisedEndpointsInput,
): readonly AdvertisedEndpoint[] => {
  const listenerHost = normalizeHost(input.listener.host);
  const endpoints: AdvertisedEndpoint[] = [];

  if (isLoopbackHost(listenerHost)) {
    endpoints.push(
      createAdvertisedEndpoint({
        provider: SERVER_ENDPOINT_PROVIDER,
        source: "server",
        id: `server-loopback:${input.listener.port}`,
        label: "This machine",
        httpBaseUrl: `http://${formatHostForUrl(listenerHost)}:${input.listener.port}`,
        reachability: "loopback",
        status: "available",
        description: "Loopback endpoint for this server.",
      }),
    );
    return endpoints;
  }

  if (!isWildcardHost(listenerHost) && isUsableSpecificListener(input.listener)) {
    const classification = reachabilityForAddress(listenerHost);
    endpoints.push(
      endpointForAddress({
        address: listenerHost,
        port: input.listener.port,
        ...classification,
      }),
    );
    return endpoints;
  }

  if (!isWildcardHost(listenerHost)) return endpoints;

  const loopbackHost = input.listener.family === "IPv6" ? "::1" : "127.0.0.1";
  endpoints.push(
    createAdvertisedEndpoint({
      provider: SERVER_ENDPOINT_PROVIDER,
      source: "server",
      id: `server-loopback:${input.listener.port}`,
      label: "This machine",
      httpBaseUrl: `http://${formatHostForUrl(loopbackHost)}:${input.listener.port}`,
      reachability: "loopback",
      status: "available",
      description: "Loopback endpoint for this server.",
    }),
  );

  const seen = new Set<string>();
  let defaultAssigned = false;
  for (const entries of Object.values(input.networkInterfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (!isUsableInterfaceAddress(entry, input.listener.family) || seen.has(entry.address)) {
        continue;
      }
      seen.add(entry.address);
      const classification = reachabilityForAddress(entry.address);
      const isDefault = classification.reachability === "lan" && !defaultAssigned;
      if (isDefault) defaultAssigned = true;
      endpoints.push(
        endpointForAddress({
          address: entry.address,
          port: input.listener.port,
          ...classification,
          ...(isDefault ? { isDefault: true } : {}),
        }),
      );
    }
  }
  return endpoints;
};

const isCompatibleTailscaleEndpoint = (
  endpoint: AdvertisedEndpoint,
  listener: LiveListener,
): boolean => {
  try {
    const url = new URL(endpoint.httpBaseUrl);
    if (url.protocol === "https:") {
      return (
        endpoint.compatibility.hostedHttpsApp === "compatible" &&
        (isLoopbackHost(listener.host) ||
          isWildcardHost(listener.host) ||
          listener.family === "IPv4")
      );
    }
    if (url.protocol !== "http:" || listener.family !== "IPv4") return false;
    return (
      isWildcardHost(listener.host) || normalizeHost(url.hostname) === normalizeHost(listener.host)
    );
  } catch {
    return false;
  }
};

export const resolveServerAdvertisedEndpoints = (
  input: ResolveServerAdvertisedEndpointsInput,
): readonly AdvertisedEndpoint[] => {
  const endpoints = new Map<string, AdvertisedEndpoint>();
  for (const endpoint of [
    ...resolveCoreEndpoints(input),
    ...(input.tailscaleEndpoints ?? []).filter((endpoint) =>
      isCompatibleTailscaleEndpoint(endpoint, input.listener),
    ),
  ]) {
    endpoints.set(endpoint.httpBaseUrl, endpoint);
  }
  return [...endpoints.values()];
};

const isLoopbackProxyHost = (host: string): boolean => {
  const normalized = normalizeHost(host);
  return normalized === "localhost" || isLoopbackHost(normalized);
};

const proxyTargetMatchesListener = (target: string, listener: LiveListener): boolean => {
  try {
    const url = new URL(target);
    if (url.protocol !== "http:" || url.username || url.password) return false;
    if (!url.port || Number.parseInt(url.port, 10) !== listener.port) return false;
    const targetHost = normalizeHost(url.hostname);
    if (!isLoopbackProxyHost(targetHost)) return false;
    if (targetHost === "localhost") {
      return isLoopbackHost(listener.host) || isWildcardHost(listener.host);
    }
    if (NodeNet.isIP(targetHost) !== NodeNet.isIP(listener.host)) return false;
    if (isWildcardHost(listener.host)) return true;
    return targetHost === normalizeHost(listener.host);
  } catch {
    return false;
  }
};

const verifyServeIdentity = (
  baseUrl: string,
  environmentId: string,
  client: HttpClient.HttpClient,
): Effect.Effect<boolean> =>
  HttpClient.get(`${baseUrl}.well-known/t3/environment`).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", cache: "no-store" }),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
    Effect.timeout("2500 millis"),
    Effect.map((descriptor) => descriptor.environmentId === environmentId),
    Effect.orElseSucceed(() => false),
  );

export const resolveVerifiedTailscaleServeEndpoints = (input: {
  readonly listener: LiveListener;
  readonly mappings: readonly TailscaleServeMapping[];
  readonly magicDnsName: string | null;
  readonly environmentId: string;
  readonly client: HttpClient.HttpClient;
}): Effect.Effect<readonly AdvertisedEndpoint[], never> =>
  Effect.forEach(
    input.mappings.filter(
      (mapping) =>
        input.magicDnsName !== null &&
        mapping.magicDnsName.toLowerCase() === input.magicDnsName.toLowerCase() &&
        proxyTargetMatchesListener(mapping.target, input.listener),
    ),
    (mapping) => {
      const baseUrl = buildTailscaleHttpsBaseUrl({
        magicDnsName: mapping.magicDnsName,
        servePort: mapping.servePort,
      });
      return verifyServeIdentity(baseUrl, input.environmentId, input.client).pipe(
        Effect.map((verified) =>
          verified
            ? createAdvertisedEndpoint({
                provider: {
                  id: "tailscale",
                  label: "Tailscale",
                  kind: "private-network",
                  isAddon: true,
                },
                source: "server",
                id: `tailscale-magicdns:${baseUrl}`,
                label: "Tailscale HTTPS",
                httpBaseUrl: baseUrl,
                reachability: "private-network",
                hostedHttpsCompatibility: "compatible",
                status: "available",
                description: "HTTPS endpoint served by an existing Tailscale Serve mapping.",
              })
            : null,
        ),
      );
    },
    { concurrency: 4 },
  ).pipe(
    Effect.map((endpoints) =>
      endpoints.filter((endpoint): endpoint is AdvertisedEndpoint => endpoint !== null),
    ),
  );

export const resolveTailscaleEndpoints = (input: {
  readonly listener: LiveListener;
  readonly networkInterfaces: TailscaleNetworkInterfaces;
  readonly environmentId: string;
  readonly client: HttpClient.HttpClient;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}): Effect.Effect<readonly AdvertisedEndpoint[], never> =>
  Effect.gen(function* () {
    const listenerHost = normalizeHost(input.listener.host);
    const canUseTailnetIps =
      input.listener.family === "IPv4" &&
      (isWildcardHost(listenerHost) ||
        (isUsableIpv4(listenerHost) && listenerHost.startsWith("100.")));

    const status = yield* readTailscaleStatus.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
    );
    const ipEndpoints = canUseTailnetIps
      ? (yield* resolveTailscaleAdvertisedEndpoints({
          port: input.listener.port,
          source: "server",
          networkInterfaces: input.networkInterfaces,
          readMagicDnsName: Effect.succeed(status.magicDnsName),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
          Effect.provideService(HttpClient.HttpClient, input.client),
        )).filter(
          (endpoint) =>
            endpoint.status === "available" &&
            endpoint.httpBaseUrl.startsWith("http://") &&
            isCompatibleTailscaleEndpoint(endpoint, input.listener),
        )
      : [];

    const mappings = yield* readTailscaleServeMappings.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
      Effect.catch((error) =>
        Effect.logDebug("Tailscale Serve inspection unavailable", { reason: error._tag }).pipe(
          Effect.as([] as readonly TailscaleServeMapping[]),
        ),
      ),
    );
    const verifiedServeEndpoints = yield* resolveVerifiedTailscaleServeEndpoints({
      listener: input.listener,
      mappings,
      magicDnsName: status.magicDnsName,
      environmentId: input.environmentId,
      client: input.client,
    });
    return [...ipEndpoints, ...verifiedServeEndpoints];
  }).pipe(
    Effect.catchTags({
      TailscaleCommandSpawnError: () => Effect.succeed([]),
      TailscaleCommandOutputError: () => Effect.succeed([]),
      TailscaleCommandExitError: () => Effect.succeed([]),
      TailscaleCommandTimeoutError: () => Effect.succeed([]),
      TailscaleStatusParseError: () => Effect.succeed([]),
    }),
  );

export class ServerAdvertisedEndpoints extends Context.Service<
  ServerAdvertisedEndpoints,
  { readonly getEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]> }
>()("t3/remoteAccess/ServerAdvertisedEndpoints") {}

export const make = Effect.gen(function* () {
  const httpServer = yield* HttpServer.HttpServer;
  const environment = yield* ServerEnvironment;
  const client = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const resolveEndpoints = Effect.gen(function* () {
    if (httpServer.address._tag !== "TcpAddress") return [];
    const family = listenerFamily(httpServer.address.hostname);
    if (!family || httpServer.address.port < 1) return [];
    const listener: LiveListener = {
      host: httpServer.address.hostname,
      family,
      port: httpServer.address.port,
    };
    const networkInterfaces = NodeOS.networkInterfaces() as TailscaleNetworkInterfaces;
    const tailscaleEndpoints = yield* resolveTailscaleEndpoints({
      listener,
      networkInterfaces,
      environmentId: String(yield* environment.getEnvironmentId),
      client,
      spawner,
    });
    return resolveServerAdvertisedEndpoints({
      listener,
      networkInterfaces,
      tailscaleEndpoints,
    });
  }).pipe(
    Effect.catchCause(() =>
      Effect.logWarning("endpoint discovery unavailable").pipe(
        Effect.as([] as readonly AdvertisedEndpoint[]),
      ),
    ),
  );

  const getEndpoints = yield* Effect.cachedWithTTL(resolveEndpoints, ENDPOINT_CACHE_TTL);
  return ServerAdvertisedEndpoints.of({ getEndpoints });
});

export const layer = Layer.effect(ServerAdvertisedEndpoints, make);
