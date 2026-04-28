import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("ServerSettings", () => {
  it("defaults copilot provider settings", () => {
    expect(DEFAULT_SERVER_SETTINGS.providers.copilot).toEqual({
      enabled: false,
      binaryPath: "copilot",
      customModels: [],
    });
  });

  it("decodes copilot provider settings from persisted JSON", () => {
    const parsed = decodeServerSettings({
      providers: {
        copilot: {
          enabled: true,
          binaryPath: "/opt/homebrew/bin/copilot",
          customModels: ["gpt-5"],
        },
      },
    });

    expect(parsed.providers.copilot).toEqual({
      enabled: true,
      binaryPath: "/opt/homebrew/bin/copilot",
      customModels: ["gpt-5"],
    });
  });
});

describe("ServerSettingsPatch", () => {
  it("accepts copilot settings and model selection patches", () => {
    const parsed = decodeServerSettingsPatch({
      textGenerationModelSelection: {
        provider: "copilot",
        model: "gpt-5.4",
        options: [{ id: "reasoning", value: "high" }],
      },
      providers: {
        copilot: {
          enabled: true,
          binaryPath: "/opt/homebrew/bin/copilot",
          customModels: ["gpt-5"],
        },
      },
    });

    expect(parsed.textGenerationModelSelection?.provider).toBe("copilot");
    if (parsed.textGenerationModelSelection?.provider !== "copilot") {
      throw new Error("Expected copilot textGenerationModelSelection");
    }
    expect(parsed.textGenerationModelSelection.options).toEqual([
      { id: "reasoning", value: "high" },
    ]);
    expect(parsed.providers?.copilot?.binaryPath).toBe("/opt/homebrew/bin/copilot");
  });
});
