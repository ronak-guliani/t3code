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

describe("owned mobile compatibility", () => {
  it("accepts the existing fork through capabilities, not an unreliable app version", () => {
    expect(mobileCompatibility(config)).toEqual({
      status: "supported",
      protocol: "legacy-capabilities",
    });
  });

  it("accepts owned wire version 1 and rejects unknown versions", () => {
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
      ).toBe(version === 1 ? "supported" : "unsupported");
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
});
