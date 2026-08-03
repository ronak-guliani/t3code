import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import {
  buildTailscaleHttpsBaseUrl,
  DEFAULT_TAILSCALE_SERVE_PORT,
  ensureTailscaleServe,
  isTailscaleServePortConfigured,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";

import { AuthControlPlaneRuntimeLive } from "../auth/Layers/AuthControlPlane.ts";
import { AuthControlPlane } from "../auth/Services/AuthControlPlane.ts";
import * as BootService from "../cloud/bootService.ts";
import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import {
  type PersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  buildPairingUrl,
  formatHostForUrl,
  isLoopbackHost,
  isWildcardHost,
  renderTerminalQrCode,
  resolveHeadlessConnectionString,
} from "../startupAccess.ts";

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const PAIR_PROBE_TIMEOUT = Duration.millis(2_500);
const TAILSCALE_PROBE_ATTEMPTS = 5;
const TAILSCALE_PROBE_RETRY_DELAY = Duration.seconds(1);
const DEV_VARIANT_PLACEHOLDER_URL = new URL("http://localhost");

type PairStateVariant = "userdata" | "dev";

export class NoRunningServerError extends Schema.TaggedErrorClass<NoRunningServerError>()(
  "NoRunningServerError",
  { checkedStatePaths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return [
      "No running T3 Code server found.",
      ...this.checkedStatePaths.map((statePath) => `  checked ${statePath}`),
      "Start one with `npx t3 serve`, or install the background service with `npx t3 service install`.",
    ].join("\n");
  }
}

export class TailscaleUnavailableError extends Schema.TaggedErrorClass<TailscaleUnavailableError>()(
  "TailscaleUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not talk to Tailscale. Is tailscaled running? Try `tailscale status`.";
  }
}

export class MagicDnsNameMissingError extends Schema.TaggedErrorClass<MagicDnsNameMissingError>()(
  "MagicDnsNameMissingError",
  {},
) {
  override get message(): string {
    return "This machine has no MagicDNS name. Run `tailscale up` and enable MagicDNS.";
  }
}

export class ServesOtherEnvironmentError extends Schema.TaggedErrorClass<ServesOtherEnvironmentError>()(
  "ServesOtherEnvironmentError",
  { servePort: Schema.Finite },
) {
  override get message(): string {
    return `Tailscale Serve on HTTPS port ${String(this.servePort)} already fronts a different T3 Code server. Pass --tailscale-serve-port to publish this one on another port.`;
  }
}

export class TailscaleServeFailedError extends Schema.TaggedErrorClass<TailscaleServeFailedError>()(
  "TailscaleServeFailedError",
  { servePort: Schema.Finite, cause: Schema.Defect() },
) {
  override get message(): string {
    return `tailscale serve failed for HTTPS port ${String(this.servePort)}. Run \`tailscale serve --https=${String(this.servePort)} --bg <local-url>\` by hand to inspect the failure.`;
  }
}

export class ServePortOccupiedError extends Schema.TaggedErrorClass<ServePortOccupiedError>()(
  "ServePortOccupiedError",
  { servePort: Schema.Finite },
) {
  override get message(): string {
    return `HTTPS port ${String(this.servePort)} on the tailnet already serves something that is not T3 Code. Pass --tailscale-serve-port to use another port.`;
  }
}

export class ServePortUnreachableError extends Schema.TaggedErrorClass<ServePortUnreachableError>()(
  "ServePortUnreachableError",
  { servePort: Schema.Finite },
) {
  override get message(): string {
    return `HTTPS port ${String(this.servePort)} already has a Tailscale Serve mapping, but its target is unreachable. Refusing to replace it; choose another --tailscale-serve-port or remove the existing mapping explicitly.`;
  }
}

export class DevServerNotProxiableError extends Schema.TaggedErrorClass<DevServerNotProxiableError>()(
  "DevServerNotProxiableError",
  { devUrl: Schema.String },
) {
  override get message(): string {
    return `Tailscale Serve can only proxy plain HTTP local targets, but this dev server uses ${this.devUrl}. Pair without --tailscale instead.`;
  }
}

const isDevServerNotProxiableError = Schema.is(DevServerNotProxiableError);

interface PairRuntimeStateCandidate {
  readonly baseDir: string;
  readonly variant: PairStateVariant;
  readonly statePath: string;
  readonly source: "service" | "foreground";
}

interface DiscoveredPairTarget extends PairRuntimeStateCandidate {
  readonly state: PersistedServerRuntimeState;
  readonly descriptor: ExecutionEnvironmentDescriptor;
}

export type EnvironmentProbeResult =
  | { readonly _tag: "descriptor"; readonly descriptor: ExecutionEnvironmentDescriptor }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "not-a-t3-server" };

export const decideTailscaleMapping = (input: {
  readonly existing: EnvironmentProbeResult;
  readonly environmentId: string;
  readonly devServer: boolean;
  readonly servePort: number;
  readonly servePortConfigured: boolean;
}):
  | "configure"
  | "reuse"
  | ServesOtherEnvironmentError
  | ServePortOccupiedError
  | ServePortUnreachableError => {
  if (input.existing._tag === "not-a-t3-server") {
    return new ServePortOccupiedError({ servePort: input.servePort });
  }
  if (input.existing._tag === "unreachable") {
    return input.servePortConfigured
      ? new ServePortUnreachableError({ servePort: input.servePort })
      : "configure";
  }
  if (input.existing.descriptor.environmentId !== input.environmentId) {
    return new ServesOtherEnvironmentError({ servePort: input.servePort });
  }
  return input.devServer ? "configure" : "reuse";
};

const processIsOwnedAndAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const probeEnvironmentDescriptor = (
  baseUrl: string,
): Effect.Effect<EnvironmentProbeResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(HttpClientRequest.get(new URL(WELL_KNOWN_ENVIRONMENT_PATH, baseUrl).toString()))
      .pipe(
        Effect.timeout(PAIR_PROBE_TIMEOUT),
        Effect.mapError(() => ({ _tag: "unreachable" }) as const),
      );
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return { _tag: "unreachable" } as const;
    }
    const descriptor = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() => ({ _tag: "not-a-t3-server" }) as const),
    );
    return { _tag: "descriptor", descriptor } as const;
  }).pipe(Effect.catch((outcome) => Effect.succeed(outcome)));

export const resolveDirectPairingBaseUrl = (state: PersistedServerRuntimeState): string =>
  state.devUrl ?? resolveHeadlessConnectionString(state.host, state.port);

export const resolveTailscaleLocalTarget = (
  state: PersistedServerRuntimeState,
): { readonly localPort: number; readonly localHost?: string } | DevServerNotProxiableError => {
  if (state.devUrl !== undefined) {
    const devUrl = new URL(state.devUrl);
    if (devUrl.protocol !== "http:") {
      return new DevServerNotProxiableError({ devUrl: state.devUrl });
    }
    const localPort = devUrl.port ? Number.parseInt(devUrl.port, 10) : 80;
    return isLoopbackHost(devUrl.hostname)
      ? { localPort }
      : { localPort, localHost: devUrl.hostname };
  }
  if (state.host && !isWildcardHost(state.host) && !isLoopbackHost(state.host)) {
    return { localPort: state.port, localHost: formatHostForUrl(state.host) };
  }
  return { localPort: state.port };
};

const resolveServiceStatePath = (baseDir: string) =>
  Effect.gen(function* () {
    if (process.platform !== "darwin" || typeof process.getuid !== "function") return undefined;
    const canonicalBaseDir = yield* Effect.tryPromise(() =>
      BootService.liveServiceHost.canonicalize(baseDir),
    ).pipe(Effect.option);
    return Option.isSome(canonicalBaseDir)
      ? BootService.servicePaths({
          homeDir: homedir(),
          canonicalBaseDir: canonicalBaseDir.value,
          userId: process.getuid(),
        }).runtimeStatePath
      : undefined;
  });

export const resolveCandidatesForBaseDir = Effect.fn(function* (
  baseDir: string,
  serviceStatePathOverride?: string,
) {
  const serviceStatePath = serviceStatePathOverride ?? (yield* resolveServiceStatePath(baseDir));
  const userdataPaths = yield* deriveServerPaths(baseDir, undefined);
  const devPaths = yield* deriveServerPaths(baseDir, DEV_VARIANT_PLACEHOLDER_URL);
  return [
    ...(serviceStatePath
      ? [
          {
            baseDir,
            variant: "userdata" as const,
            statePath: serviceStatePath,
            source: "service" as const,
          },
        ]
      : []),
    {
      baseDir,
      variant: "userdata" as const,
      statePath: userdataPaths.serverRuntimeStatePath,
      source: "foreground" as const,
    },
    {
      baseDir,
      variant: "dev" as const,
      statePath: devPaths.serverRuntimeStatePath,
      source: "foreground" as const,
    },
  ];
});

const discoverPairTarget = Effect.fn("pair.discover")(function* (
  explicitBaseDir: string | undefined,
) {
  const baseDirs: string[] = [];
  if (explicitBaseDir?.trim()) {
    baseDirs.push(yield* resolveBaseDir(explicitBaseDir));
  } else {
    const worktreeHome = yield* resolveWorktreeT3Home(process.cwd());
    if (worktreeHome) baseDirs.push(worktreeHome);
    const configuredHome = yield* Config.string("T3CODE_HOME").pipe(Config.option);
    baseDirs.push(yield* resolveBaseDir(Option.getOrUndefined(configuredHome)));
  }

  const candidates = [];
  for (const baseDir of new Set(baseDirs)) {
    candidates.push(...(yield* resolveCandidatesForBaseDir(baseDir)));
  }

  for (const candidate of candidates) {
    const state = yield* readPersistedServerRuntimeState(candidate.statePath);
    if (Option.isNone(state) || !processIsOwnedAndAlive(state.value.pid)) continue;
    const derivedPaths = yield* deriveServerPaths(
      candidate.baseDir,
      candidate.variant === "dev" ? DEV_VARIANT_PLACEHOLDER_URL : undefined,
    );
    const environmentId = yield* Effect.tryPromise(() =>
      readFile(derivedPaths.environmentIdPath, "utf8"),
    ).pipe(Effect.option);
    if (Option.isNone(environmentId)) continue;
    const probed = yield* probeEnvironmentDescriptor(state.value.origin);
    if (
      probed._tag !== "descriptor" ||
      probed.descriptor.environmentId !== environmentId.value.trim()
    ) {
      continue;
    }
    return {
      ...candidate,
      state: state.value,
      descriptor: probed.descriptor,
    } satisfies DiscoveredPairTarget;
  }
  return yield* new NoRunningServerError({
    checkedStatePaths: candidates.map((candidate) => candidate.statePath),
  });
});

const makePairServerConfig = Effect.fn(function* (input: {
  readonly target: DiscoveredPairTarget;
  readonly logLevel: ServerConfigShape["logLevel"];
}) {
  const devUrl = input.target.state.devUrl ? new URL(input.target.state.devUrl) : undefined;
  const derivedPaths = yield* deriveServerPaths(
    input.target.baseDir,
    input.target.variant === "dev" ? DEV_VARIANT_PLACEHOLDER_URL : undefined,
  );
  return {
    logLevel: input.logLevel,
    traceMinLevel: "Info",
    traceTimingEnabled: false,
    traceBatchWindowMs: 1_000,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server",
    mode: "web",
    port: input.target.state.port,
    host: input.target.state.host,
    cwd: process.cwd(),
    baseDir: input.target.baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl,
    noBrowser: true,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
  } satisfies ServerConfigShape;
});

const awaitEnvironmentDescriptor = Effect.fn(function* (baseUrl: string) {
  let last: EnvironmentProbeResult = { _tag: "unreachable" };
  for (let attempt = 0; attempt < TAILSCALE_PROBE_ATTEMPTS; attempt += 1) {
    last = yield* probeEnvironmentDescriptor(baseUrl);
    if (last._tag === "descriptor") return last;
    yield* Effect.sleep(TAILSCALE_PROBE_RETRY_DELAY);
  }
  return last;
});

const resolveTailscalePairingBase = Effect.fn(function* (input: {
  readonly target: DiscoveredPairTarget;
  readonly servePort: number;
}) {
  const notes: string[] = [];
  const status = yield* readTailscaleStatus.pipe(
    Effect.mapError((cause) => new TailscaleUnavailableError({ cause })),
  );
  if (!status.magicDnsName) return yield* new MagicDnsNameMissingError();

  const baseUrl = buildTailscaleHttpsBaseUrl({
    magicDnsName: status.magicDnsName,
    servePort: input.servePort,
  });
  const existing = yield* probeEnvironmentDescriptor(baseUrl);
  const servePortConfigured =
    existing._tag === "unreachable"
      ? yield* isTailscaleServePortConfigured(input.servePort).pipe(
          Effect.mapError((cause) => new TailscaleUnavailableError({ cause })),
        )
      : true;
  const decision = decideTailscaleMapping({
    existing,
    environmentId: input.target.descriptor.environmentId,
    devServer: input.target.state.devUrl !== undefined,
    servePort: input.servePort,
    servePortConfigured,
  });
  if (decision !== "configure" && decision !== "reuse") return yield* decision;
  if (decision === "reuse") return { baseUrl, notes };

  const localTarget = resolveTailscaleLocalTarget(input.target.state);
  if (isDevServerNotProxiableError(localTarget)) return yield* localTarget;
  yield* ensureTailscaleServe({
    localPort: localTarget.localPort,
    servePort: input.servePort,
    ...(localTarget.localHost ? { localHost: localTarget.localHost } : {}),
  }).pipe(
    Effect.mapError(
      (cause) => new TailscaleServeFailedError({ servePort: input.servePort, cause }),
    ),
  );
  notes.push(
    `Tailscale Serve maps ${baseUrl} to this server and persists across restarts. Remove only this mapping with \`tailscale serve --https=${String(input.servePort)} off\`.`,
  );

  const confirmed = yield* awaitEnvironmentDescriptor(baseUrl);
  if (
    confirmed._tag === "descriptor" &&
    confirmed.descriptor.environmentId !== input.target.descriptor.environmentId
  ) {
    return yield* new ServesOtherEnvironmentError({ servePort: input.servePort });
  }
  if (confirmed._tag !== "descriptor") {
    notes.push(
      "The HTTPS endpoint is not reachable yet; initial Tailscale certificate provisioning can take a moment.",
    );
  }
  return { baseUrl, notes };
});

export const formatPairOutput = (input: {
  readonly serverLabel: string;
  readonly origin: string;
  readonly pairingUrl: string;
  readonly token: string;
  readonly expiresAt: DateTime.Utc;
  readonly source: "service" | "foreground";
  readonly notes: ReadonlyArray<string>;
}): string =>
  [
    `Pairing with ${input.serverLabel} (${input.origin}, ${input.source}).`,
    "",
    renderTerminalQrCode(input.pairingUrl),
    "",
    `Pairing URL: ${input.pairingUrl}`,
    `Token: ${input.token}`,
    `Expires: ${DateTime.formatIso(input.expiresAt)}`,
    ...input.notes.flatMap((note) => ["", `Note: ${note}`]),
    "",
  ].join("\n");

const parseDurationInput = (value: string): Duration.Duration | null => {
  const shorthand = /^(?<value>\d+)(?<unit>ms|s|m|h|d|w)$/i.exec(value.trim());
  const normalized = shorthand?.groups
    ? `${shorthand.groups.value} ${
        {
          ms: "millis",
          s: "seconds",
          m: "minutes",
          h: "hours",
          d: "days",
          w: "weeks",
        }[shorthand.groups.unit?.toLowerCase() ?? ""]
      }`
    : value.trim();
  const decoded = Duration.fromInput(normalized as Duration.Input);
  return Option.getOrNull(decoded);
};

const DurationFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformOrFail({
      decode: (value) => {
        const duration = parseDurationInput(value);
        return duration
          ? Effect.succeed(duration)
          : Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(value), {
                message: "Invalid duration. Use values like 5m, 1h, or 15 minutes.",
              }),
            );
      },
      encode: (duration) => Effect.succeed(Duration.format(duration)),
    }),
  ),
);

const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription(
    "Base directory whose running foreground server or service should be paired.",
  ),
  Flag.optional,
);
const ttlFlag = Flag.string("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("Token TTL, for example 5m, 1h, or 15 minutes."),
  Flag.optional,
);
const labelFlag = Flag.string("label").pipe(
  Flag.withDescription("Client label shown in Connections."),
  Flag.optional,
);
const tailscaleFlag = Flag.boolean("tailscale").pipe(
  Flag.withDescription("Provision or reuse persistent Tailscale Serve HTTPS."),
  Flag.withDefault(false),
);
const tailscaleServePortFlag = Flag.integer("tailscale-serve-port").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))),
  Flag.withDescription("Tailnet HTTPS port used with --tailscale."),
  Flag.withDefault(DEFAULT_TAILSCALE_SERVE_PORT),
);

export const pairCommand = Command.make("pair", {
  baseDir: baseDirFlag,
  ttl: ttlFlag,
  label: labelFlag,
  tailscale: tailscaleFlag,
  tailscaleServePort: tailscaleServePortFlag,
}).pipe(
  Command.withDescription(
    "Mint a one-time client credential for a running T3 Code server and print its QR code.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const cliLogLevel = yield* GlobalFlag.LogLevel;
      const logLevel = Option.getOrElse(cliLogLevel, () => "Warn" as const);
      const target = yield* discoverPairTarget(Option.getOrUndefined(flags.baseDir));
      const notes: string[] = [];
      const pairingBaseUrl = flags.tailscale
        ? yield* resolveTailscalePairingBase({
            target,
            servePort: flags.tailscaleServePort,
          }).pipe(
            Effect.map((resolved) => {
              notes.push(...resolved.notes);
              return resolved.baseUrl;
            }),
          )
        : resolveDirectPairingBaseUrl(target.state);
      if (!flags.tailscale && isLoopbackHost(new URL(pairingBaseUrl).hostname)) {
        notes.push(
          "This URL is reachable only from this machine. Re-run with --tailscale or bind the server to a reachable host.",
        );
      }

      const config = yield* makePairServerConfig({ target, logLevel });
      const issued = yield* Effect.gen(function* () {
        const authControlPlane = yield* AuthControlPlane;
        return yield* authControlPlane.createPairingLink({
          role: "client",
          subject: "one-time-token",
          label: Option.getOrElse(flags.label, () => "t3 pair"),
          ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
        });
      }).pipe(
        Effect.provide(
          AuthControlPlaneRuntimeLive.pipe(
            Layer.provide(Layer.succeed(ServerConfig, config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, logLevel)),
          ),
        ),
      );
      const pairingUrl = buildPairingUrl(pairingBaseUrl, issued.credential);
      yield* Console.log(
        formatPairOutput({
          serverLabel: target.descriptor.label,
          origin: target.state.origin,
          pairingUrl,
          token: issued.credential,
          expiresAt: issued.expiresAt,
          source: target.source,
          notes,
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);
