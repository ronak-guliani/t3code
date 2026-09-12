import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRepoEnv } from "./public-config.ts";

export const clientBuildInputs = [
  "apps/web/src",
  "apps/web/public",
  "apps/web/index.html",
  "apps/web/package.json",
  "apps/web/vite.config.ts",
  "packages/shared/src",
  "packages/shared/package.json",
  "packages/contracts/src",
  "packages/contracts/package.json",
  "packages/client-runtime/src",
  "packages/client-runtime/package.json",
  "pnpm-lock.yaml",
  "scripts/lib/public-config.ts",
  "scripts/lib/client-build.ts",
] as const;

export function clientSourceFingerprint(root: string): string {
  const hash = createHash("sha256");
  const visit = (relative: string) => {
    if (relative === "apps/web/src/routeTree.gen.ts") return;
    const path = join(root, relative);
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(`${relative}/${name}`);
    } else {
      hash.update(relative).update("\0").update(readFileSync(path)).update("\0");
    }
  };
  for (const input of clientBuildInputs) visit(input);
  return hash.digest("hex");
}

export function clientConfigurationFingerprint(
  root: string,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
) {
  const env = loadRepoEnv({ repoRoot: root, baseEnv });
  const sourcemap = env.T3CODE_WEB_SOURCEMAP?.trim().toLowerCase();
  const publicConfig = Object.fromEntries(
    Object.keys(env)
      .filter((key) => key.startsWith("VITE_") && env[key]?.trim())
      .sort()
      .map((key) => [key, env[key]!.trim()]),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        publicConfig,
        sourcemap:
          sourcemap === "0" || sourcemap === "false"
            ? false
            : sourcemap === "hidden"
              ? "hidden"
              : true,
      }),
    )
    .digest("hex");
}

export function writeClientBuildStamp(
  root: string,
  output: string,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
) {
  writeFileSync(
    join(output, ".t3-build.json"),
    JSON.stringify({
      version: 2,
      fingerprint: clientSourceFingerprint(root),
      configuration: clientConfigurationFingerprint(root, baseEnv),
    }),
  );
}

export function assertFreshClientBuild(
  root: string,
  output: string,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
) {
  const stamp: unknown = JSON.parse(readFileSync(join(output, ".t3-build.json"), "utf8"));
  if (
    typeof stamp !== "object" ||
    stamp === null ||
    !("version" in stamp) ||
    stamp.version !== 2 ||
    !("fingerprint" in stamp) ||
    stamp.fingerprint !== clientSourceFingerprint(root) ||
    !("configuration" in stamp) ||
    stamp.configuration !== clientConfigurationFingerprint(root, baseEnv)
  ) {
    throw new Error("Bundled web assets are stale. Run pnpm build from the repository root.");
  }
}
