// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv, resolvePublicConfig } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("only uses example public defaults when requested and keeps overrides higher priority", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.example"),
      "T3CODE_RELAY_URL=https://default.example.test\nT3CODE_CLERK_PUBLISHABLE_KEY=pk_example\n",
    );
    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBeUndefined();
    expect(loadRepoEnv({ baseEnv: {}, repoRoot, includeExample: true })).toMatchObject({
      T3CODE_RELAY_URL: "https://default.example.test",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_example",
    });
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "VITE_T3CODE_RELAY_URL=https://local.example.test\n",
    );
    expect(loadRepoEnv({ baseEnv: {}, repoRoot, includeExample: true }).T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({ baseEnv: {}, repoRoot, includeExample: true }).T3CODE_CLERK_PUBLISHABLE_KEY,
    ).toBeUndefined();
    expect(
      loadRepoEnv({
        baseEnv: { VITE_T3CODE_RELAY_URL: "https://process.example.test" },
        repoRoot,
        includeExample: true,
      }).T3CODE_RELAY_URL,
    ).toBe("https://process.example.test");
  });

  it.each([
    "T3CODE_RELAY_URL",
    "VITE_T3CODE_RELAY_URL",
    "T3CODE_CLERK_PUBLISHABLE_KEY",
    "VITE_CLERK_PUBLISHABLE_KEY",
    "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "T3CODE_CLERK_JWT_TEMPLATE",
    "VITE_CLERK_JWT_TEMPLATE",
    "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
  ])("does not mix example defaults with an explicit %s override", (key) => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.example"),
      "T3CODE_RELAY_URL=https://production.example.test\nT3CODE_CLERK_PUBLISHABLE_KEY=pk_production\nT3CODE_CLERK_JWT_TEMPLATE=production\nMOBILE_CLERK_IOS_REDIRECT_URL=production://callback\n",
    );
    for (const source of ["process", ".env", ".env.local"]) {
      for (const value of ["custom", ""]) {
        const baseEnv = source === "process" ? { [key]: value } : {};
        if (source !== "process") {
          NodeFS.writeFileSync(NodePath.join(repoRoot, source), `${key}=${value}\n`);
        }
        const env = loadRepoEnv({ baseEnv, repoRoot, includeExample: true });
        expect(env).toEqual({
          ...loadRepoEnv({ baseEnv, repoRoot }),
          MOBILE_CLERK_IOS_REDIRECT_URL: "production://callback",
        });
        expect(Object.values(env)).not.toContain("pk_production");
        expect(Object.values(env)).not.toContain("https://production.example.test");
        expect(Object.values(env)).not.toContain("production");
        if (source !== "process") {
          NodeFS.unlinkSync(NodePath.join(repoRoot, source));
        }
      }
    }
  });

  it("resolves a complete deployment across explicit sources and preserves callback overrides", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.example"),
      "T3CODE_RELAY_URL=https://production.example.test\nMOBILE_CLERK_IOS_REDIRECT_URL=production://callback\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_custom\nT3CODE_CLERK_JWT_TEMPLATE=custom\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "VITE_T3CODE_RELAY_URL=https://custom.example.test\n",
    );
    const env = loadRepoEnv({
      baseEnv: {
        EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "process-template",
        MOBILE_CLERK_IOS_REDIRECT_URL: "custom://callback",
      },
      repoRoot,
      includeExample: true,
    });
    expect(resolvePublicConfig(env)).toMatchObject({
      clerkPublishableKey: "pk_custom",
      clerkJwtTemplate: "process-template",
      relayUrl: "https://custom.example.test",
    });
    expect(env.MOBILE_CLERK_IOS_REDIRECT_URL).toBe("custom://callback");
  });

  it("does not project cloud configuration for an unconfigured clone", () => {
    const env = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });

    expect(env.T3CODE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.T3CODE_HOSTED_APP_URL).toBeUndefined();
    expect(env.VITE_HOSTED_APP_URL).toBeUndefined();
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.T3CODE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.VITE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.T3CODE_RELAY_URL).toBeUndefined();
    expect(env.VITE_T3CODE_RELAY_URL).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_URL).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_URL).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_TOKEN).toBeUndefined();
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_CLERK_JWT_TEMPLATE=template_root\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_local\nT3CODE_CLERK_JWT_TEMPLATE=template_local\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nT3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          T3CODE_HOSTED_APP_URL: "https://custom.example.test",
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      T3CODE_HOSTED_APP_URL: "https://custom.example.test",
      VITE_HOSTED_APP_URL: "https://custom.example.test",
      VITE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });

  it("accepts legacy framework aliases as root overrides", () => {
    expect(
      resolvePublicConfig({
        VITE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
        VITE_CLERK_JWT_TEMPLATE: "template_legacy",
        T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_canonical",
        VITE_HOSTED_APP_URL: "https://legacy-hosted.example.test",
        VITE_T3CODE_RELAY_URL: "https://legacy.example.test",
        EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
        EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
        EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
      }),
    ).toEqual({
      clerkPublishableKey: "pk_legacy",
      clerkJwtTemplate: "template_legacy",
      clerkCliOAuthClientId: "oauth_canonical",
      hostedAppUrl: "https://legacy-hosted.example.test",
      relayUrl: "https://legacy.example.test",
      mobileOtlpTracesUrl: "https://api.axiom.co/v1/traces",
      mobileOtlpTracesDataset: "mobile-traces",
      mobileOtlpTracesToken: "mobile-token",
      relayClientOtlpTracesUrl: undefined,
      relayClientOtlpTracesDataset: undefined,
      relayClientOtlpTracesToken: undefined,
    });
  });

  it("projects canonical relay client tracing values to web build aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
          T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
      VITE_RELAY_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      VITE_RELAY_OTLP_TRACES_DATASET: "relay-client-traces",
      VITE_RELAY_OTLP_TRACES_TOKEN: "relay-client-token",
    });
  });

  it("projects canonical mobile tracing values to Expo public aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_RELAY_URL: "https://relay.example.test",
          T3CODE_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          T3CODE_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
          T3CODE_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      T3CODE_RELAY_URL: "https://relay.example.test",
      VITE_T3CODE_RELAY_URL: "https://relay.example.test",
      T3CODE_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      T3CODE_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
      T3CODE_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
      EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
      EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
