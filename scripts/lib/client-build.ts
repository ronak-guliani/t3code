import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const clientBuildInputs = [
  "apps/web/src",
  "apps/web/public",
  "apps/web/index.html",
  "apps/web/package.json",
  "apps/web/vite.config.ts",
  "packages/shared/src",
  "packages/contracts/src",
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

export function writeClientBuildStamp(root: string, output: string) {
  writeFileSync(
    join(output, ".t3-build.json"),
    JSON.stringify({ version: 1, fingerprint: clientSourceFingerprint(root) }),
  );
}

export function assertFreshClientBuild(root: string, output: string) {
  const stamp: unknown = JSON.parse(readFileSync(join(output, ".t3-build.json"), "utf8"));
  if (
    typeof stamp !== "object" ||
    stamp === null ||
    !("version" in stamp) ||
    stamp.version !== 1 ||
    !("fingerprint" in stamp) ||
    stamp.fingerprint !== clientSourceFingerprint(root)
  ) {
    throw new Error("Bundled web assets are stale. Run pnpm build from the repository root.");
  }
}
