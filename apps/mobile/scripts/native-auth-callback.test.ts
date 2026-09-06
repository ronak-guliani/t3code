import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);

describe("installed Clerk native callback bridge", () => {
  it("passes the configured callback and scheme without replacing keychain identity", () => {
    const clerkRoot = dirname(require.resolve("@clerk/expo/package.json"));
    const bridge = readFileSync(join(clerkRoot, "ios/ClerkNativeBridge.swift"), "utf8");
    const options = bridge.match(
      /private static func makeClerkOptions\(\) -> Clerk.Options \{([\s\S]*?)\n  \}/,
    )?.[1];
    expect(options).toBeDefined();
    expect(options).toContain('object(forInfoDictionaryKey: "ClerkRedirectUrl")');
    expect(options).toContain("URL(string: redirectUrl)?.scheme");
    expect(options).toContain(".init(redirectUrl: redirectUrl, callbackUrlScheme: scheme)");
    expect(options).toContain("redirectConfig = .init()");
    expect(options).toContain(
      "return .init(redirectConfig: redirectConfig, middleware: middleware)",
    );
    expect(options).toContain(
      ".init(keychainConfig: .init(service: service), redirectConfig: redirectConfig, middleware: middleware)",
    );
    expect(bridge).toContain("return Bundle.main.bundleIdentifier");
  });
});
