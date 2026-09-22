import { describe, expect, it } from "vitest";
import { delimiter } from "node:path";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("keeps the server-matched CLI first even with provider PATH overrides", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "PATH", value: "/custom/bin", sensitive: false },
          { name: "T3CODE_HOME", value: "/other-home", sensitive: false },
        ],
        {
          PATH: "/server/bin",
          T3CODE_AGENT_CLI_DIR: "/server/agent-cli",
          T3CODE_HOME: "/server-home",
        },
      ),
    ).toMatchObject({
      PATH: `/server/agent-cli${delimiter}/custom/bin`,
      T3CODE_HOME: "/server-home",
    });
  });
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });
});
