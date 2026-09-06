import { describe, expect, it } from "vite-plus/test";

import { makeMobileConfig as makeConfig } from "./app.config";
import eas from "./eas.json";
import mobilePackage from "./package.json";
import repoPackage from "../../package.json";

const variants = [
  ["development", "T3 Code RG Dev", "com.ronakguliani.t3code.dev", "t3code-rg-dev"],
  ["preview", "T3 Code RG Preview", "com.ronakguliani.t3code.preview", "t3code-rg-preview"],
  ["production", "T3 Code RG", "com.ronakguliani.t3code", "t3code-rg"],
] as const;
const ownedProject = {
  MOBILE_EAS_OWNER: "my-account",
  MOBILE_EAS_PROJECT_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
};
const connectConfig = {
  T3CODE_RELAY_URL: "https://relay.example.test",
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_mobile",
  T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
};
const makeMobileConfig = (env: Readonly<Record<string, string | undefined>>) =>
  makeConfig({ ...connectConfig, ...env });

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

  it("restores Connect without enabling hosted push, telemetry, or OTA", () => {
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
      agentAwarenessPushEnabled: false,
      relay: { url: "https://relay.t3.codes" },
      clerk: { publishableKey: "pk_test_mobile", jwtTemplate: "t3-relay" },
      observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
      eas: { projectId: "01272cd5-225c-47d4-978e-a7eb97c9e457" },
    });
    expect(config.plugins).toContainEqual(["@clerk/expo", { theme: "./clerk-theme.json" }]);
    expect(config.updates).toEqual({ enabled: false, checkAutomatically: "NEVER" });
    expect(config.runtimeVersion).toEqual({ policy: "fingerprint" });
  });

  it("preserves an explicit Direct Connect-only build", () => {
    const config = makeConfig({
      MOBILE_CONNECT_ENABLED: "false",
      MOBILE_CLERK_IOS_REDIRECT_URL: "com.t3tools.t3code://callback",
    });
    expect(config.extra).toMatchObject({
      relay: { url: null },
      clerk: { publishableKey: null, jwtTemplate: null },
      agentAwarenessPushEnabled: false,
    });
    expect(config.plugins).not.toContainEqual(expect.arrayContaining(["@clerk/expo"]));
    expect(config.ios?.infoPlist).not.toHaveProperty("ClerkRedirectUrl");
    expect(config.ios?.infoPlist).not.toHaveProperty("CFBundleURLTypes");
  });

  it.each(variants)(
    "overrides only the %s OAuth callback, not app or keychain identity",
    (variant, _name, id, scheme) => {
      const config = makeMobileConfig({
        APP_VARIANT: variant,
        MOBILE_CLERK_IOS_REDIRECT_URL: "com.t3tools.t3code://callback",
      });
      expect(config.ios?.bundleIdentifier).toBe(id);
      expect(config.android?.package).toBe(id);
      expect(config.scheme).toBe(scheme);
      expect(config.ios?.infoPlist).toMatchObject({
        ClerkRedirectUrl: "com.t3tools.t3code://callback",
        CFBundleURLTypes: [{ CFBundleURLSchemes: [scheme, id, "com.t3tools.t3code"] }],
      });
      expect(config.ios?.infoPlist).not.toHaveProperty("ClerkKeychainService");
    },
  );

  it("retains SDK callback defaults when no override is configured", () => {
    expect(makeMobileConfig({}).ios?.infoPlist).not.toHaveProperty("ClerkRedirectUrl");
  });

  it.each([
    "https://example.com/callback",
    "http://localhost/callback",
    "missing-scheme",
    "app://callback?token=secret",
    "app://callback#fragment",
    "app://user:password@callback",
  ])("rejects an invalid native callback override: %s", (url) => {
    expect(() => makeMobileConfig({ MOBILE_CLERK_IOS_REDIRECT_URL: url })).toThrow(
      "MOBILE_CLERK_IOS_REDIRECT_URL",
    );
  });

  it.each(Object.keys(connectConfig))("rejects incomplete Connect config without %s", (key) => {
    expect(() => makeMobileConfig({ [key]: "" })).toThrow("T3 Connect requires");
  });

  it.each(["http://relay.example.test", "not-a-url", "https://relay.example.test/path"])(
    "rejects an invalid relay origin: %s",
    (url) => {
      expect(() => makeMobileConfig({ T3CODE_RELAY_URL: url })).toThrow("secure T3CODE_RELAY_URL");
    },
  );

  it("rejects an ambiguous Connect flag", () => {
    expect(() => makeMobileConfig({ MOBILE_CONNECT_ENABLED: "yes" })).toThrow(
      "MOBILE_CONNECT_ENABLED must be true or false",
    );
  });

  it("accepts the shared framework aliases for Connect configuration", () => {
    expect(
      makeConfig({
        VITE_T3CODE_RELAY_URL: connectConfig.T3CODE_RELAY_URL,
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: connectConfig.T3CODE_CLERK_PUBLISHABLE_KEY,
        EXPO_PUBLIC_CLERK_JWT_TEMPLATE: connectConfig.T3CODE_CLERK_JWT_TEMPLATE,
      }).extra,
    ).toMatchObject({
      relay: { url: connectConfig.T3CODE_RELAY_URL },
      clerk: {
        publishableKey: connectConfig.T3CODE_CLERK_PUBLISHABLE_KEY,
        jwtTemplate: connectConfig.T3CODE_CLERK_JWT_TEMPLATE,
      },
    });
  });

  it("resolves the provisioned owned project without an account login or local env file", () => {
    const config = makeMobileConfig({});
    expect(config.owner).toBe("ronakguliani");
    expect(config.extra?.eas).toEqual({ projectId: "01272cd5-225c-47d4-978e-a7eb97c9e457" });
    expect(config.ios?.appleTeamId).toBe("235XX73T5A");
  });

  it("links an explicitly owned Expo project without enabling OTA", () => {
    const config = makeMobileConfig({
      ...ownedProject,
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

  it.each(["ARK85ZXQ4Z", "personal", "invalid-team"])(
    "rejects an invalid Apple team: %s",
    (team) => {
      expect(() => makeMobileConfig({ MOBILE_APPLE_TEAM_ID: team })).toThrow(
        "own 10-character Apple team",
      );
    },
  );

  it.each(variants)("isolates the %s share extension and permissions", (variant, _name, id) => {
    const config = makeMobileConfig({ APP_VARIANT: variant });
    expect(config.plugins).toContainEqual([
      "expo-sharing",
      expect.objectContaining({
        ios: expect.objectContaining({
          enabled: true,
          extensionBundleIdentifier: `${id}.sharing`,
          appGroupId: `group.${id}`,
        }),
      }),
    ]);
    expect(config.plugins).toContainEqual([
      "expo-audio",
      expect.objectContaining({
        enableBackgroundRecording: false,
        enableBackgroundPlayback: false,
      }),
    ]);
  });
});

describe("mobile build entrypoints", () => {
  it("updates the installed Preview app through cable-free internal distribution", () => {
    expect(repoPackage.scripts["ios:update"]).toBe("pnpm --filter @t3tools/mobile ios:update");
    expect(mobilePackage.scripts["ios:update"]).toBe(
      "eas build --profile preview --platform ios --wait",
    );
    expect(eas.build.preview).toMatchObject({
      env: { APP_VARIANT: "preview" },
      distribution: "internal",
    });
    expect(eas.build.preview).not.toHaveProperty("developmentClient", true);
    expect(eas.build.preview).not.toHaveProperty("ios.simulator", true);
    expect(
      makeMobileConfig({ APP_VARIANT: eas.build.preview.env.APP_VARIANT }).ios?.bundleIdentifier,
    ).toBe("com.ronakguliani.t3code.preview");
  });

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
        if (platform === "ios") {
          expect(steps.shift()).toBe("node scripts/ios-preflight.mts");
        }
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

  it("uses the project-pinned CLI and profile for every EAS build command", () => {
    expect(mobilePackage.devDependencies["eas-cli"]).toBe(eas.cli.version);
    for (const [name, script] of Object.entries(mobilePackage.scripts)) {
      if (name.startsWith("eas:")) {
        expect(script).toMatch(/^eas build --profile /);
      }
    }
  });

  it("links native authentication on both platforms", () => {
    expect(mobilePackage.expo.autolinking).not.toHaveProperty("ios.exclude");
    expect(mobilePackage.expo.autolinking).not.toHaveProperty("android.exclude");
  });

  it("separates internal preview, TestFlight preview, and production", () => {
    expect(eas.build.preview.env.APP_VARIANT).toBe("preview");
    expect(eas.build.preview.distribution).toBe("internal");
    expect(eas.build.preview.android.buildType).toBe("apk");
    expect(eas.build.testflight.extends).toBe("production");
    expect(eas.build.testflight.env.APP_VARIANT).toBe("preview");
    expect(eas.build.production.distribution).toBe("store");
    expect(eas.build.production.env.APP_VARIANT).toBe("production");
    expect(eas.build["development:simulator"]).toEqual({
      extends: "development",
      ios: { simulator: true },
    });
    expect(eas.build["preview:simulator"]).toEqual({
      extends: "preview",
      ios: { simulator: true },
    });
    expect(eas.build.base).toMatchObject({
      node: "24.18.0",
      pnpm: "11.10.0",
      ios: { image: "macos-tahoe-26.5-xcode-26.6" },
    });
    expect(eas.submit).toEqual({
      production: { ios: { appleTeamId: "235XX73T5A" } },
      testflight: { ios: { appleTeamId: "235XX73T5A" } },
    });
    for (const profile of Object.values(eas.build)) {
      expect(profile).not.toHaveProperty("channel");
    }
  });
});
