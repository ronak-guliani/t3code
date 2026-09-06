import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveEnvironmentMachineKind } from "./environmentMachine.ts";

const config: Pick<ServerConfig, "environment" | "settings"> = {
  settings: DEFAULT_SERVER_SETTINGS,
  environment: {
    environmentId: EnvironmentId.make("test-environment"),
    label: "Test environment",
    serverVersion: "0.0.0",
    platform: { os: "darwin", arch: "arm64" },
    capabilities: { repositoryIdentity: false },
  },
};

describe("resolveEnvironmentMachineKind", () => {
  it("uses the server icon before configuration is available", () => {
    expect(resolveEnvironmentMachineKind(null)).toBe("server");
  });

  it("preserves the server fallback for legacy descriptors without machine metadata", () => {
    expect(resolveEnvironmentMachineKind(config)).toBe("server");
  });

  it("uses detected hardware when no icon override is configured", () => {
    expect(
      resolveEnvironmentMachineKind({
        ...config,
        environment: {
          ...config.environment,
          platform: { ...config.environment.platform, machine: "mac-mini" },
        },
      }),
    ).toBe("mac-mini");
  });

  it("prefers the configured icon to detected hardware", () => {
    expect(
      resolveEnvironmentMachineKind({
        ...config,
        settings: { ...config.settings, environmentIcon: "cloud" },
        environment: {
          ...config.environment,
          platform: { ...config.environment.platform, machine: "laptop" },
        },
      }),
    ).toBe("cloud");
  });
});
