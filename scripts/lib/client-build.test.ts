import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertFreshClientBuild,
  clientBuildInputs,
  clientSourceFingerprint,
  writeClientBuildStamp,
} from "./client-build.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "t3-build-contract-"));
  directories.push(root);
  for (const input of clientBuildInputs) {
    const path = join(root, input);
    if (input.endsWith("/src") || input.endsWith("/public")) mkdirSync(path, { recursive: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, input);
    }
  }
  const dist = join(root, "apps/web/dist");
  mkdirSync(dist);
  return { root, dist };
}
it("refuses missing or stale assets and permits unchanged source", () => {
  const { root, dist } = fixture();
  expect(() => assertFreshClientBuild(root, dist)).toThrow();
  writeClientBuildStamp(root, dist);
  expect(() => assertFreshClientBuild(root, dist)).not.toThrow();
  writeFileSync(join(root, "packages/shared/src/changed.ts"), "export const changed = true");
  expect(() => assertFreshClientBuild(root, dist)).toThrow("stale");
});
it("does not let generated route metadata invalidate a build", () => {
  const { root } = fixture();
  const before = clientSourceFingerprint(root);
  writeFileSync(join(root, "apps/web/src/routeTree.gen.ts"), "generated");
  expect(clientSourceFingerprint(root)).toBe(before);
});
