import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePnpmWorkspaceConfig } from "./lib/pnpm-workspace.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = resolve(repoRoot, "apps/server");
const webDir = resolve(repoRoot, "apps/web");
const serverManifestPath = resolve(serverDir, "package.json");
let tempDir: string | undefined;
let originalManifest: string | undefined;

function run(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>> = {},
) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      npm_config_ignore_scripts: "true",
      npm_config_update_notifier: "false",
    },
  });
}

function assertContains(output: string, value: string) {
  if (!output.includes(value)) {
    throw new Error(`Expected packaged CLI output to contain ${JSON.stringify(value)}.`);
  }
}

function readJavaScriptFiles(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return readJavaScriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".js") ? readFileSync(path, "utf8") : "";
    })
    .join("\n");
}

try {
  originalManifest = readFileSync(serverManifestPath, "utf8");
  tempDir = mkdtempSync(join(repoRoot, "t3-cli-package-smoke-"));
  const embeddedPublicConfig = {
    T3CODE_RELAY_URL: "https://release-smoke-relay.example.test",
    T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
    T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "release-smoke-oauth-client",
    T3CODE_HOSTED_APP_URL: "https://release-smoke-hosted.example.test",
  };
  run(process.execPath, ["--run", "build"], webDir, embeddedPublicConfig);
  const webBundle = readJavaScriptFiles(resolve(webDir, "dist"));
  for (const value of [
    embeddedPublicConfig.T3CODE_CLERK_PUBLISHABLE_KEY,
    embeddedPublicConfig.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID,
    embeddedPublicConfig.T3CODE_HOSTED_APP_URL,
  ]) {
    assertContains(webBundle, value);
  }

  run(process.execPath, ["apps/server/scripts/cli.ts", "build"], repoRoot, embeddedPublicConfig);
  const bundle = readFileSync(resolve(serverDir, "dist/bin.mjs"), "utf8");
  for (const value of [
    embeddedPublicConfig.T3CODE_RELAY_URL,
    embeddedPublicConfig.T3CODE_CLERK_PUBLISHABLE_KEY,
    embeddedPublicConfig.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID,
  ]) {
    assertContains(bundle, value);
  }
  const manifest = JSON.parse(originalManifest) as {
    readonly dependencies: Record<string, string>;
  };
  const workspace = parsePnpmWorkspaceConfig(
    readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8"),
  );
  writeFileSync(
    serverManifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        dependencies: resolveCatalogDependencies(
          manifest.dependencies,
          workspace.catalog,
          "apps/server",
        ),
      },
      null,
      2,
    )}\n`,
  );
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", tempDir], serverDir),
  ) as ReadonlyArray<{
    readonly filename: string;
  }>;
  if (!packed[0]?.filename) {
    throw new Error("npm pack did not produce a CLI tarball.");
  }
  const tarball = resolve(tempDir, packed[0].filename);

  run("npm", ["init", "--yes"], tempDir);
  run("npm", ["install", "--ignore-scripts", "--no-package-lock", tarball], tempDir);

  for (const args of [
    ["t3", "pair", "--help"],
    ["t3", "connect", "--help"],
    ["t3", "connect", "login", "--headless", "--help"],
    ["t3", "connect", "link", "--headless", "--help"],
    ["t3", "connect", "status", "--help"],
  ]) {
    const output = run("npx", ["--offline", "--no-install", ...args], tempDir);
    assertContains(output, `t3 ${args[1]}`);
  }
  assertContains(
    run("npx", ["--offline", "--no-install", "t3", "connect", "--help"], tempDir),
    "logout",
  );
  console.log("Packaged T3 Connect CLI smoke passed.");
} finally {
  if (originalManifest !== undefined) {
    writeFileSync(serverManifestPath, originalManifest);
  }
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
