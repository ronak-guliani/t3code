import { describe, expect, it } from "vite-plus/test";

import { makeMobileConfig } from "./app.config";
import eas from "./eas.json";
import mobilePackage from "./package.json";

const variants = [
  ["development", "T3 Code RG Dev", "com.ronakguliani.t3code.dev", "t3code-rg-dev"],
  ["preview", "T3 Code RG Preview", "com.ronakguliani.t3code.preview", "t3code-rg-preview"],
  ["production", "T3 Code RG", "com.ronakguliani.t3code", "t3code-rg"],
] as const;
const ownedProject = {
  MOBILE_EAS_OWNER: "my-account",
  MOBILE_EAS_PROJECT_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
};

describe("owned mobile build configuration", () => {
  it.each(variants)("isolates the %s app and widget identities", (variant, name, id, scheme) => {
    const config = makeMobileConfig({ APP_VARIANT: variant });
    expect(config.name).toBe(name);
    expect(config.ios?.bundleIdentifier).toBe(id);
    expect(config.android?.package).toBe(id);
    expect(config.scheme).toBe(scheme);
    expect(config.plugins).toContainEqual([
      "expo-widgets",
      expect.objectContaining({
        bundleIdentifier: `${id}.widgets`,
        groupIdentifier: `group.${id}`,
        enablePushNotifications: false,
      }),
    ]);
  });

  it("defaults local commands to the development identity", () => {
    expect(makeMobileConfig({}).ios?.bundleIdentifier).toBe(variants[0][2]);
  });

  it.each(["prod", "Preview", "", "unknown"])("rejects an invalid variant: %s", (APP_VARIANT) => {
    expect(() => makeMobileConfig({ APP_VARIANT })).toThrow("Unknown APP_VARIANT");
  });

  it("does not inherit desktop cloud or telemetry configuration", () => {
    const config = makeMobileConfig({
      T3CODE_RELAY_URL: "https://relay.t3.codes",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_not_for_mobile",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "t3-relay",
      EXPO_PUBLIC_OTLP_TRACES_URL: "https://example.com/traces",
      EXPO_PUBLIC_OTLP_TRACES_DATASET: "desktop",
      EXPO_PUBLIC_OTLP_TRACES_TOKEN: "not-for-mobile",
      MOBILE_VERSION_POLICY: "appVersion",
    });
    expect(config.extra).toEqual({
      appVariant: "development",
      relay: { url: null },
      clerk: { publishableKey: null, jwtTemplate: null },
      observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    });
    expect(config.plugins).not.toContainEqual(expect.arrayContaining(["@clerk/expo"]));
    expect(config.updates).toEqual({ enabled: false, checkAutomatically: "NEVER" });
    expect(config.runtimeVersion).toEqual({ policy: "fingerprint" });
  });

  it("needs no Expo account to resolve a local build", () => {
    const config = makeMobileConfig({});
    expect(config.owner).toBeUndefined();
    expect(config.extra?.eas).toBeUndefined();
  });

  it("links an explicitly owned Expo project without enabling OTA", () => {
    const config = makeMobileConfig({
      ...ownedProject,
      MOBILE_REQUIRE_EAS_PROJECT: "1",
      EAS_BUILD: "true",
    });
    expect(config.slug).toBe("t3-code-rg");
    expect(config.owner).toBe("my-account");
    expect(config.extra?.eas).toEqual({ projectId: ownedProject.MOBILE_EAS_PROJECT_ID });
    expect(config.updates?.enabled).toBe(false);
    expect(config.updates?.url).toBeUndefined();
  });

  it.each([
    { MOBILE_EAS_OWNER: "my-account" },
    { MOBILE_EAS_PROJECT_ID: ownedProject.MOBILE_EAS_PROJECT_ID },
    { ...ownedProject, MOBILE_EAS_OWNER: " " },
  ])("rejects partially configured Expo ownership: %o", (env) => {
    expect(() => makeMobileConfig(env)).toThrow("Set both MOBILE_EAS_OWNER");
  });

  it("rejects a placeholder project ID", () => {
    expect(() =>
      makeMobileConfig({ ...ownedProject, MOBILE_EAS_PROJECT_ID: "your-project-id" }),
    ).toThrow("UUID");
  });

  it.each([
    { ...ownedProject, MOBILE_EAS_OWNER: "pingdotgg" },
    { ...ownedProject, MOBILE_EAS_PROJECT_ID: "d763fcb8-d37c-41ea-a773-b54a0ab4a454" },
    { ...ownedProject, MOBILE_EAS_PROJECT_ID: "D763FCB8-D37C-41EA-A773-B54A0AB4A454" },
  ])("rejects the upstream Expo project: %o", (env) => {
    expect(() => makeMobileConfig(env)).toThrow("Upstream Expo ownership");
  });

  it.each([{ MOBILE_REQUIRE_EAS_PROJECT: "1" }, { EAS_BUILD: "true" }])(
    "fails closed for an unconfigured EAS build: %o",
    (env) => {
      expect(() => makeMobileConfig(env)).toThrow("EAS builds require your own");
    },
  );
});

describe("mobile build entrypoints", () => {
  it.each(["ios", "android"] as const)(
    "keeps the same %s variant through prebuild and compilation",
    (platform) => {
      for (const [variant, suffix] of [
        ["development", "dev"],
        ["preview", "preview"],
        ["production", "prod"],
      ] as const) {
        const script = mobilePackage.scripts[`${platform}:${suffix}`];
        const steps = script.split(" && ");
        expect(steps).toHaveLength(2);
        for (const step of steps) {
          expect(step).toMatch(new RegExp(`^APP_VARIANT=${variant} `));
        }
        if (variant !== "development") {
          expect(steps[1]).toContain("--no-bundler");
          expect(steps[1]).toContain(
            platform === "ios" ? "--configuration Release" : "--variant release",
          );
        }
      }
    },
  );

  it("starts Metro with the owned development scheme", () => {
    expect(mobilePackage.scripts["dev:client"]).toContain(`--scheme ${variants[0][3]}`);
  });

  it("requires owned configuration in every EAS build command", () => {
    for (const [name, script] of Object.entries(mobilePackage.scripts)) {
      if (name.startsWith("eas:")) {
        expect(script).toMatch(/^MOBILE_REQUIRE_EAS_PROJECT=1 eas build /);
      }
    }
  });

  it("separates internal preview, TestFlight preview, and production", () => {
    expect(eas.build.preview.env.APP_VARIANT).toBe("preview");
    expect(eas.build.preview.distribution).toBe("internal");
    expect(eas.build.preview.android.buildType).toBe("apk");
    expect(eas.build.testflight.extends).toBe("production");
    expect(eas.build.testflight.env.APP_VARIANT).toBe("preview");
    expect(eas.build.production.distribution).toBe("store");
    expect(eas.build.production.env.APP_VARIANT).toBe("production");
    expect(eas.submit).toEqual({ production: {}, testflight: {} });
    for (const profile of Object.values(eas.build)) {
      expect(profile).not.toHaveProperty("channel");
    }
  });
});
