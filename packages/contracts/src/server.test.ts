import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerProvider, ServerProviderListCommandsInput } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding legacy snapshots", () => {
    const parsed = decodeServerProvider({
      provider: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
  });
});

describe("ServerProviderListCommandsInput", () => {
  it("accepts Copilot project command lookup requests", () => {
    expect(
      Schema.decodeUnknownSync(ServerProviderListCommandsInput)({
        provider: "copilot",
        cwd: "/repo/project",
      }),
    ).toEqual({
      provider: "copilot",
      cwd: "/repo/project",
    });
  });
});
