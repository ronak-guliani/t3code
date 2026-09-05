import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);

describe("resolved Expo native configuration", () => {
  it.each([
    ["development", "com.ronakguliani.t3code.dev", "t3code-rg-dev"],
    ["preview", "com.ronakguliani.t3code.preview", "t3code-rg-preview"],
    ["production", "com.ronakguliani.t3code", "t3code-rg"],
  ])("keeps the %s native app isolated after all plugins", (variant, id, scheme) => {
    const output = execFileSync(
      process.execPath,
      [require.resolve("expo/bin/cli"), "config", "--type", "introspect", "--json"],
      {
        cwd: fileURLToPath(new URL(".", import.meta.url)),
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          APP_VARIANT: variant,
          MOBILE_EAS_OWNER: "",
          MOBILE_EAS_PROJECT_ID: "",
          EAS_BUILD: "",
        },
      },
    );
    const config: unknown = JSON.parse(output);
    expect(config).toMatchObject({
      ios: { bundleIdentifier: id },
      android: { package: id },
      scheme,
      updates: { enabled: false, checkAutomatically: "NEVER" },
    });
    expect(config).not.toHaveProperty("updates.url");
    expect(config).toHaveProperty("extra.eas.projectId", "01272cd5-225c-47d4-978e-a7eb97c9e457");
    expect(config).toHaveProperty("ios.appleTeamId", "235XX73T5A");
    expect(config).toHaveProperty("_internal.modResults.ios.entitlements", {
      "com.apple.security.application-groups": [`group.${id}`],
    });
    expect(config).toHaveProperty(
      "_internal.modResults.ios.infoPlist.CFBundleURLTypes",
      expect.arrayContaining([
        expect.objectContaining({ CFBundleURLSchemes: expect.arrayContaining([scheme]) }),
      ]),
    );
    expect(config).toHaveProperty(
      "_internal.modResults.ios.infoPlist.CFBundleURLTypes",
      expect.not.arrayContaining([
        expect.objectContaining({
          CFBundleURLSchemes: expect.arrayContaining(["t3code"]),
        }),
      ]),
    );
    if (variant !== "development") {
      expect(output).not.toContain("exp+t3-code-rg");
    }
  });
});
