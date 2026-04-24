import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path } from "effect";

import {
  applyCopilotConfiguredModelMetadata,
  extractCopilotConfiguredModel,
  hasConcreteCopilotCurrentModel,
  readCopilotMergedSettings,
} from "./CopilotSettings.ts";

const TestLayer = Layer.empty.pipe(Layer.provideMerge(NodeServices.layer));

const makeTempDir = Effect.fn("makeTempDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-copilot-settings-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, contents);
});

const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: null,
  },
];

it.layer(TestLayer)("CopilotSettings", (it) => {
  describe("readCopilotMergedSettings", () => {
    it.effect("merges project config over user config", () =>
      Effect.gen(function* () {
        const homeDir = yield* makeTempDir();
        const cwd = yield* makeTempDir();
        yield* writeTextFile(homeDir, ".copilot/config.json", JSON.stringify({ model: "user" }));
        yield* writeTextFile(cwd, ".copilot/config.json", JSON.stringify({ model: "project" }));

        const settings = yield* readCopilotMergedSettings({ cwd, homeDir });

        expect(settings.model).toBe("project");
        expect(settings.userConfig?.model).toBe("user");
        expect(settings.projectConfig?.model).toBe("project");
        expect(settings.warnings).toEqual([]);
      }),
    );

    it.effect("uses user config when project config is absent", () =>
      Effect.gen(function* () {
        const homeDir = yield* makeTempDir();
        const cwd = yield* makeTempDir();
        yield* writeTextFile(homeDir, ".copilot/config.json", JSON.stringify({ model: "user" }));

        const settings = yield* readCopilotMergedSettings({ cwd, homeDir });

        expect(settings.model).toBe("user");
        expect(settings.projectConfig).toBeUndefined();
        expect(settings.warnings).toEqual([]);
      }),
    );

    it.effect("accepts commented Copilot config files", () =>
      Effect.gen(function* () {
        const homeDir = yield* makeTempDir();
        const cwd = yield* makeTempDir();
        yield* writeTextFile(
          homeDir,
          ".copilot/config.json",
          `{
  // User selected model
  "model": "gpt-5.4",
}
`,
        );

        const settings = yield* readCopilotMergedSettings({ cwd, homeDir });

        expect(settings.model).toBe("gpt-5.4");
        expect(settings.userConfig?.model).toBe("gpt-5.4");
        expect(settings.warnings).toEqual([]);
      }),
    );

    it.effect("reports malformed JSON as a warning without failing", () =>
      Effect.gen(function* () {
        const homeDir = yield* makeTempDir();
        const cwd = yield* makeTempDir();
        yield* writeTextFile(homeDir, ".copilot/config.json", "{");
        yield* writeTextFile(cwd, ".copilot/config.json", JSON.stringify({ model: "project" }));

        const settings = yield* readCopilotMergedSettings({ cwd, homeDir });

        expect(settings.model).toBe("project");
        expect(settings.userConfig).toBeUndefined();
        expect(settings.warnings).toHaveLength(1);
        expect(settings.warnings[0]?.message).toContain("not valid JSON");
      }),
    );
  });

  describe("extractCopilotConfiguredModel", () => {
    it("extracts top-level and object-shaped model values", () => {
      expect(extractCopilotConfiguredModel({ model: " gpt-5.4 " })).toBe("gpt-5.4");
      expect(extractCopilotConfiguredModel({ model: { id: "claude-sonnet-4.6" } })).toBe(
        "claude-sonnet-4.6",
      );
      expect(extractCopilotConfiguredModel({ model: { slug: "gpt-5.4-mini" } })).toBe(
        "gpt-5.4-mini",
      );
      expect(extractCopilotConfiguredModel({ model: 42 })).toBeUndefined();
    });
  });

  describe("applyCopilotConfiguredModelMetadata", () => {
    it("surfaces configured model on Auto when ACP reports auto or empty current model", () => {
      expect(
        applyCopilotConfiguredModelMetadata({
          models,
          configuredModel: "gpt-5.4",
          currentModel: "auto",
        })[0]?.name,
      ).toBe("Auto (gpt-5.4)");
      expect(
        applyCopilotConfiguredModelMetadata({
          models,
          configuredModel: "gpt-5.4",
          currentModel: "",
        })[0]?.name,
      ).toBe("Auto (gpt-5.4)");
    });

    it("leaves model metadata alone when ACP reports a concrete current model", () => {
      expect(hasConcreteCopilotCurrentModel("gpt-5.4")).toBe(true);
      expect(
        applyCopilotConfiguredModelMetadata({
          models,
          configuredModel: "claude-sonnet-4.6",
          currentModel: "gpt-5.4",
        }),
      ).toBe(models);
    });
  });
});
