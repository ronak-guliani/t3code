import { createRequire } from "node:module";
import { describe, expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve("expo/config-plugins"));
const pluginsRequire = createRequire(expoRequire.resolve("@expo/config-plugins"));
const xcode = pluginsRequire("xcode");
const withShareExtensionDisplayName = require("./withShareExtensionDisplayName.cjs");

function fixture() {
  const project = xcode.project("unused.pbxproj");
  project.hash = {
    project: {
      objects: {
        PBXGroup: {},
        PBXFileReference: {},
        PBXBuildFile: {},
        PBXNativeTarget: {
          SHARE: {
            name: "expo-sharing-extension",
            buildConfigurationList: "CONFIGURATIONS",
            buildPhases: [],
          },
        },
        XCConfigurationList: {
          CONFIGURATIONS: { buildConfigurations: [{ value: "DEBUG" }] },
        },
        XCBuildConfiguration: {
          DEBUG: {
            buildSettings: {
              INFOPLIST_FILE: '"expo-sharing-extension/Info.plist"',
              DEVELOPMENT_TEAM: '"OWNED_TEAM"',
              PRODUCT_BUNDLE_IDENTIFIER: '"com.ronakguliani.t3code.dev.share-extension"',
            },
          },
        },
      },
    },
  };
  return project;
}

async function apply(project: ReturnType<typeof fixture>) {
  const config = withShareExtensionDisplayName({ name: "T3 Code RG Dev", slug: "t3-code-rg" });
  await config.mods.ios.xcodeproj({ ...config, modResults: project, modRequest: {} });
}

describe("share extension Xcode references", () => {
  it("separates the plist reference reused by the widget and sharing plugins", async () => {
    const project = fixture();
    const widget = project.addPbxGroup(["Info.plist"], "ExpoWidgetsTarget", "ExpoWidgetsTarget");
    const share = project.addPbxGroup(
      ["Info.plist"],
      "expo-sharing-extension",
      "expo-sharing-extension",
    );
    const widgetReference = widget.pbxGroup.children[0].value;
    expect(share.pbxGroup.children[0].value).toBe(widgetReference);
    const objects = project.hash.project.objects;
    const buildFiles = structuredClone(objects.PBXBuildFile);
    const targets = structuredClone(objects.PBXNativeTarget);
    const buildSettings = structuredClone(objects.XCBuildConfiguration.DEBUG.buildSettings);

    await apply(project);

    const shareReference = share.pbxGroup.children[0].value;
    expect(shareReference).not.toBe(widgetReference);
    expect(widget.pbxGroup.children[0].value).toBe(widgetReference);
    expect(objects.PBXFileReference[shareReference]).toEqual(
      objects.PBXFileReference[widgetReference],
    );
    expect(objects.PBXFileReference[`${shareReference}_comment`]).toBe("Info.plist");
    expect(objects.PBXBuildFile).toEqual(buildFiles);
    expect(objects.PBXNativeTarget).toEqual(targets);
    expect(objects.XCBuildConfiguration.DEBUG.buildSettings).toEqual({
      ...buildSettings,
      INFOPLIST_KEY_CFBundleDisplayName: '"T3 Code RG Dev"',
    });
    const repaired = structuredClone(objects);
    await apply(project);
    expect(objects).toEqual(repaired);
  });

  it("keeps a unique reference and handles names quoted by the Xcode parser", async () => {
    const project = fixture();
    const share = project.addPbxGroup(
      ["Info.plist"],
      "expo-sharing-extension",
      "expo-sharing-extension",
    );
    share.pbxGroup.name = '"expo-sharing-extension"';
    project.hash.project.objects.PBXNativeTarget.SHARE.name = '"expo-sharing-extension"';
    const references = structuredClone(project.hash.project.objects.PBXFileReference);

    await apply(project);

    expect(project.hash.project.objects.PBXFileReference).toEqual(references);
  });
});
