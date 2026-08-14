import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";

import { PR_MONITOR_MCP_TOOL_NAMES, monitorToolNamesForThread } from "./monitorTools.ts";

const instances = {
  [ProviderInstanceId.make("copilot_work")]: {
    driver: ProviderDriverKind.make("copilot"),
  },
  [ProviderInstanceId.make("codex_personal")]: {
    driver: ProviderDriverKind.make("codex"),
  },
} as unknown as ProviderInstanceConfigMap;

describe("monitorToolNamesForThread", () => {
  it("advertises monitor tools for MCP-capable drivers", () => {
    expect(
      monitorToolNamesForThread({ instanceId: "copilot_work", providerInstances: instances }),
    ).toEqual(PR_MONITOR_MCP_TOOL_NAMES);
    // Built-in defaults use the driver kind as their instance id.
    expect(monitorToolNamesForThread({ instanceId: "copilot" })).toEqual(PR_MONITOR_MCP_TOOL_NAMES);
  });

  it("advertises nothing for drivers that do not mount the t3-code surface", () => {
    expect(
      monitorToolNamesForThread({ instanceId: "codex_personal", providerInstances: instances }),
    ).toEqual([]);
    expect(monitorToolNamesForThread({ instanceId: "codex" })).toEqual([]);
    expect(monitorToolNamesForThread({ instanceId: null })).toEqual([]);
  });
});
