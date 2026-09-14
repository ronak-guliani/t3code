import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { mobileCompatibility } from "./compatibility";

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

const SHIPPED_V1_PROTOCOL_VERSION = 1;

function shippedV1Compatibility(serverConfig: {
  readonly environment: {
    readonly capabilities: { readonly ownedMobileProtocolVersion?: number };
  };
}):
  | { readonly status: "supported" }
  | { readonly status: "unsupported"; readonly message: string } {
  const serverVersion = serverConfig.environment.capabilities.ownedMobileProtocolVersion;
  return serverVersion === undefined || serverVersion === SHIPPED_V1_PROTOCOL_VERSION
    ? { status: "supported" }
    : {
        status: "unsupported",
        message: `This server uses owned mobile protocol ${serverVersion}; this app supports version ${SHIPPED_V1_PROTOCOL_VERSION}. Install a matching app/server release.`,
      };
}

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

  it("keeps a frozen shipped v1 client from subscribing to a v2 server", () => {
    const v2ServerConfig = {
      ...config,
      environment: {
        ...config.environment,
        capabilities: {
          ...config.environment.capabilities,
          ownedMobileProtocolVersion: 2,
        },
      },
    };
    let subscriptionStarted = false;

    const compatibility = shippedV1Compatibility(v2ServerConfig);
    if (compatibility.status === "supported") {
      subscriptionStarted = true;
    }

    expect(compatibility).toEqual({
      status: "unsupported",
      message:
        "This server uses owned mobile protocol 2; this app supports version 1. Install a matching app/server release.",
    });
    expect(subscriptionStarted).toBe(false);
  });
});
