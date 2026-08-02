import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSessionConfig;
}

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly readProviderSession: (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<McpProviderSessionConfig | undefined>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly touch: (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<void>;
  readonly revokeProviderInstance: (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly lastAliveAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
  readonly providerSessions: ReadonlyMap<string, McpProviderSessionConfig>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

// Provider turns and MCP requests refresh liveness. This only bounds
// credentials whose provider session died without running normal teardown.
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const providerSessionKey = (threadId: ThreadId, providerInstanceId: ProviderInstanceId): string =>
  JSON.stringify([threadId, providerInstanceId]);

const getHttpMcpEndpointHost = (hostname: string): string => {
  const normalized = hostname.toLowerCase();
  const endpointHostname =
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
      ? "127.0.0.1"
      : hostname;
  return endpointHostname.includes(":") && !endpointHostname.startsWith("[")
    ? `[${endpointHostname}]`
    : endpointHostname;
};

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({
    records: new Map(),
    providerSessions: new Map(),
  });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint =
    httpServer.address._tag === "TcpAddress"
      ? `http://${getHttpMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp`
      : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneDead = (current: RegistryState, timestamp: number): RegistryState => {
    const hasDeadRecord = Array.from(current.records.values()).some(
      (record) => timestamp - record.lastAliveAt > livenessWindowMs,
    );
    if (!hasDeadRecord) return current;
    const records = new Map(
      Array.from(current.records).filter(
        ([, record]) => timestamp - record.lastAliveAt <= livenessWindowMs,
      ),
    );
    const activeProviderSessionIds = new Set(
      Array.from(records.values(), (record) => record.scope.providerSessionId),
    );
    return {
      records,
      providerSessions: new Map(
        Array.from(current.providerSessions).filter(([, config]) =>
          activeProviderSessionIds.has(config.providerSessionId),
        ),
      ),
    };
  };

  const revokeWhere = (
    current: RegistryState,
    predicate: (record: CredentialRecord) => boolean,
  ): RegistryState => {
    const records = new Map(Array.from(current.records).filter(([, record]) => !predicate(record)));
    if (records.size === current.records.size) return current;
    const activeProviderSessionIds = new Set(
      Array.from(records.values(), (record) => record.scope.providerSessionId),
    );
    return {
      records,
      providerSessions: new Map(
        Array.from(current.providerSessions).filter(([, config]) =>
          activeProviderSessionIds.has(config.providerSessionId),
        ),
      ),
    };
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        threadId: ThreadId.make(request.threadId),
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        capabilities: new Set(["preview"]),
        issuedAt,
      };
      const config: McpProviderSessionConfig = {
        environmentId,
        threadId: scope.threadId,
        providerSessionId,
        providerInstanceId: scope.providerInstanceId,
        endpoint,
        authorizationHeader: `Bearer ${rawToken}`,
      };
      yield* SynchronizedRef.update(state, (current) => {
        const pruned = pruneDead(current, issuedAt);
        const replaced = revokeWhere(
          pruned,
          (record) =>
            record.scope.threadId === scope.threadId &&
            record.scope.providerInstanceId === scope.providerInstanceId,
        );
        const records = new Map(replaced.records);
        records.set(tokenHash, { tokenHash, scope, lastAliveAt: issuedAt });
        const providerSessions = new Map(replaced.providerSessions);
        providerSessions.set(providerSessionKey(scope.threadId, scope.providerInstanceId), config);
        return { records, providerSessions };
      });
      return { config };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      return yield* SynchronizedRef.modify(state, (current) => {
        const pruned = pruneDead(current, timestamp);
        const record = pruned.records.get(tokenHash);
        if (!record) return [undefined, pruned] as const;
        const records = new Map(pruned.records);
        records.set(tokenHash, { ...record, lastAliveAt: timestamp });
        return [record.scope, { ...pruned, records }] as const;
      });
    },
  );

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId, providerInstanceId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.update(state, (current) => {
        const pruned = pruneDead(current, timestamp);
        const records = new Map(pruned.records);
        for (const [tokenHash, record] of pruned.records) {
          if (
            record.scope.threadId === threadId &&
            record.scope.providerInstanceId === providerInstanceId
          ) {
            records.set(tokenHash, { ...record, lastAliveAt: timestamp });
          }
        }
        return { ...pruned, records };
      });
    },
  );

  return McpSessionRegistry.of({
    issue,
    readProviderSession: (threadId, providerInstanceId) =>
      currentTimeMillis.pipe(
        Effect.flatMap((timestamp) =>
          SynchronizedRef.modify(state, (current) => {
            const pruned = pruneDead(current, timestamp);
            return [
              pruned.providerSessions.get(providerSessionKey(threadId, providerInstanceId)),
              pruned,
            ] as const;
          }),
        ),
      ),
    resolve,
    touch,
    revokeProviderInstance: Effect.fn("McpSessionRegistry.revokeProviderInstance")(
      function* (threadId, providerInstanceId) {
        yield* SynchronizedRef.update(state, (current) =>
          revokeWhere(
            current,
            (record) =>
              record.scope.threadId === threadId &&
              record.scope.providerInstanceId === providerInstanceId,
          ),
        );
      },
    ),
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* SynchronizedRef.update(state, (current) =>
          revokeWhere(current, (record) => record.scope.providerSessionId === providerSessionId),
        );
      },
    ),
    revokeAll: SynchronizedRef.set(state, { records: new Map(), providerSessions: new Map() }),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    registry.revokeAll.pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (activeMcpSessionRegistry === registry) {
            activeMcpSessionRegistry = undefined;
          }
        }),
      ),
    ),
);

export const layer: Layer.Layer<
  McpSessionRegistry,
  never,
  Crypto.Crypto | ServerEnvironment | HttpServer.HttpServer
> = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.issue(request)
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

export const readActiveMcpProviderSession = (
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
): Effect.Effect<McpProviderSessionConfig | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.readProviderSession(threadId, providerInstanceId)
    : Effect.succeed(undefined);

export const touchActiveMcpProviderInstance = (
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
): Effect.Effect<void> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.touch(threadId, providerInstanceId)
    : Effect.void;

export const revokeActiveMcpProviderSession = (providerSessionId: string): Effect.Effect<void> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.revokeProviderSession(providerSessionId)
    : Effect.void;

export const revokeActiveMcpProviderInstance = (
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
): Effect.Effect<void> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.revokeProviderInstance(threadId, providerInstanceId)
    : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
