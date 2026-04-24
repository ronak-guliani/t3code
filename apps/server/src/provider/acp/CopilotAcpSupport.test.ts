import { describe, expect, it } from "vitest";

import {
  COPILOT_AGENT_MODE_ID,
  COPILOT_LEGACY_AGENT_MODE_ID,
  COPILOT_LEGACY_AUTOPILOT_MODE_ID,
  COPILOT_LEGACY_PLAN_MODE_ID,
  COPILOT_PLAN_MODE_ID,
  buildCopilotRuntimeModeArgs,
  buildCopilotAcpSpawnInput,
  isCopilotPlanModeId,
  normalizeCopilotAcpModeId,
  resolveCopilotAcpModeId,
} from "./CopilotAcpSupport.ts";

describe("buildCopilotAcpSpawnInput", () => {
  it("builds the default GitHub Copilot ACP command with restricted inherited env", () => {
    expect(buildCopilotAcpSpawnInput(undefined, "/tmp/project", "approval-required")).toEqual({
      command: "copilot",
      args: ["--acp", "--stdio"],
      cwd: "/tmp/project",
      inheritEnv: false,
    });
  });

  it("uses the configured binary path", () => {
    expect(
      buildCopilotAcpSpawnInput({ binaryPath: "/opt/bin/copilot" }, "/tmp/project", "full-access"),
    ).toEqual({
      command: "/opt/bin/copilot",
      args: ["--acp", "--stdio", "--allow-all"],
      cwd: "/tmp/project",
      inheritEnv: false,
    });
  });
});

describe("buildCopilotRuntimeModeArgs", () => {
  it("maps full-access to allow-all startup args", () => {
    expect(buildCopilotRuntimeModeArgs("full-access")).toEqual(["--allow-all"]);
  });

  it("does not add startup args for stricter runtime modes", () => {
    expect(buildCopilotRuntimeModeArgs("approval-required")).toEqual([]);
    expect(buildCopilotRuntimeModeArgs("auto-accept-edits")).toEqual([]);
  });
});

describe("Copilot ACP mode ids", () => {
  it("maps T3 Code interaction modes to Copilot ACP session mode URIs", () => {
    expect(resolveCopilotAcpModeId("default")).toBe(COPILOT_AGENT_MODE_ID);
    expect(resolveCopilotAcpModeId(undefined)).toBe(COPILOT_AGENT_MODE_ID);
    expect(resolveCopilotAcpModeId("plan")).toBe(COPILOT_PLAN_MODE_ID);
  });

  it("normalizes canonical and legacy Copilot mode URIs", () => {
    expect(normalizeCopilotAcpModeId(COPILOT_AGENT_MODE_ID)).toBe(COPILOT_AGENT_MODE_ID);
    expect(normalizeCopilotAcpModeId(COPILOT_PLAN_MODE_ID)).toBe(COPILOT_PLAN_MODE_ID);
    expect(normalizeCopilotAcpModeId(COPILOT_LEGACY_AGENT_MODE_ID)).toBe(COPILOT_AGENT_MODE_ID);
    expect(normalizeCopilotAcpModeId(COPILOT_LEGACY_AUTOPILOT_MODE_ID)).toBe(COPILOT_AGENT_MODE_ID);
    expect(normalizeCopilotAcpModeId(COPILOT_LEGACY_PLAN_MODE_ID)).toBe(COPILOT_PLAN_MODE_ID);
    expect(normalizeCopilotAcpModeId("custom-mode")).toBe("custom-mode");
    expect(normalizeCopilotAcpModeId("  ")).toBeUndefined();
  });

  it("detects plan mode after legacy URI normalization", () => {
    expect(isCopilotPlanModeId(COPILOT_LEGACY_PLAN_MODE_ID)).toBe(true);
    expect(isCopilotPlanModeId(COPILOT_LEGACY_AGENT_MODE_ID)).toBe(false);
  });
});
