import {
  ConnectionBlockedError,
  ConnectionCompatibility,
  ConnectionResolver,
  makeConnectionDriver,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { RpcSessionFactory } from "@t3tools/client-runtime/rpc";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import { mobileCompatibility, mobileCompatibilityForVersion } from "./compatibility";

const config = {
  environment: {
    environmentId: EnvironmentId.make("test"),
    label: "Test server",
    serverVersion: "0.0.0",
    platform: { os: "darwin", arch: "arm64" } as const,
    capabilities: { repositoryIdentity: true, connectionProbe: true },
  },
  shellResumeCompletionMarker: true,
  threadResumeCompletionMarker: true,
};

describe("owned mobile compatibility", () => {
  it("accepts the existing fork through capabilities, not an unreliable app version", () => {
    expect(mobileCompatibility(config)).toEqual({
      status: "supported",
      protocol: "legacy-capabilities",
    });
  });

  it("accepts owned wire version 2 and rejects older or unknown versions", () => {
    for (const version of [1, 2, 99]) {
      expect(
        mobileCompatibility({
          ...config,
          environment: {
            ...config.environment,
            capabilities: {
              ...config.environment.capabilities,
              ownedMobileProtocolVersion: version,
            },
          },
        }).status,
      ).toBe(version === 2 ? "supported" : "unsupported");
    }
  });

  it("requires probe and both resume completion markers before connecting", () => {
    expect(mobileCompatibility({ ...config, shellResumeCompletionMarker: false }).status).toBe(
      "unsupported",
    );
    expect(mobileCompatibility({ ...config, threadResumeCompletionMarker: undefined }).status).toBe(
      "unsupported",
    );
    expect(
      mobileCompatibility({
        ...config,
        environment: { ...config.environment, capabilities: { repositoryIdentity: true } },
      }).status,
    ).toBe("unsupported");
  });

  it("surfaces an actionable upgrade error for a v1 client", () => {
    const v1Config = {
      ...config,
      environment: {
        ...config.environment,
        capabilities: {
          ...config.environment.capabilities,
          ownedMobileProtocolVersion: 1,
        },
      },
    };

    expect(mobileCompatibility(v1Config)).toEqual({
      status: "unsupported",
      message:
        "This server uses owned mobile protocol 1; this app supports version 2. Install a matching app/server release.",
    });
  });

  it("keeps the shipped v1 driver from crossing into subscription startup on a v2 server", async () => {
    const target = new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("v2-server"),
      label: "V2 server",
      httpBaseUrl: "http://127.0.0.1:13775",
      wsBaseUrl: "ws://127.0.0.1:13775",
    });
    const prepared: PreparedConnection = {
      environmentId: target.environmentId,
      label: target.label,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: "ws://127.0.0.1:13775/ws?wsTicket=synthetic",
      httpAuthorization: null,
      target,
    };
    const v2ServerConfig: ServerConfig = {
      environment: {
        ...config.environment,
        environmentId: target.environmentId,
        capabilities: {
          ...config.environment.capabilities,
          ownedMobileProtocolVersion: 2,
        },
      },
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
      cwd: "/tmp/v2-server",
      keybindingsConfigPath: "/tmp/v2-server/keybindings.json",
      keybindings: [],
      issues: [],
      providers: [],
      availableEditors: [],
      observability: {
        logsDirectoryPath: "/tmp/v2-server/logs",
        localTracingEnabled: false,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      },
      settings: DEFAULT_SERVER_SETTINGS,
      shellResumeCompletionMarker: true,
      threadResumeCompletionMarker: true,
    };
    let subscriptionStarted = false;

    const driver = await Effect.runPromise(
      makeConnectionDriver.pipe(
        Effect.provideService(ConnectionResolver, {
          prepare: () => Effect.succeed(prepared),
        }),
        Effect.provideService(RpcSessionFactory, {
          connect: () =>
            Effect.succeed({
              client: null as never,
              initialConfig: Effect.succeed(v2ServerConfig),
              ready: Effect.void,
              probe: Effect.void,
              closed: Effect.never,
            }),
        }),
        Effect.provideService(ConnectionCompatibility, {
          validate: (serverConfig) => {
            const compatibility = mobileCompatibilityForVersion(serverConfig, 1);
            return compatibility.status === "supported"
              ? Effect.void
              : Effect.fail(
                  new ConnectionBlockedError({
                    reason: "unsupported",
                    detail: compatibility.message,
                  }),
                );
          },
        }),
      ),
    );
    const outcome = await Effect.runPromise(
      Effect.scoped(
        driver
          .connect({ target, profile: Option.none() }, () => Effect.void)
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                subscriptionStarted = true;
              }),
            ),
            Effect.exit,
          ),
      ),
    );

    expect(Exit.isFailure(outcome)).toBe(true);
    if (Exit.isFailure(outcome)) {
      expect(outcome.cause.reasons).toEqual([
        expect.objectContaining({
          _tag: "Fail",
          error: expect.objectContaining({
            _tag: "ConnectionBlockedError",
            reason: "unsupported",
            detail:
              "This server uses owned mobile protocol 2; this app supports version 1. Install a matching app/server release.",
          }),
        }),
      ]);
    }
    expect(subscriptionStarted).toBe(false);
  });
});
