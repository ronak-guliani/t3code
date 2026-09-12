import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertFreshClientBuild,
  clientBuildInputs,
  clientSourceFingerprint,
  clientConfigurationFingerprint,
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

it("rejects a client-runtime-only source change", () => {
  const { root, dist } = fixture();
  writeClientBuildStamp(root, dist, {});
  writeFileSync(
    join(root, "packages/client-runtime/src/changed.ts"),
    "export const changed = true",
  );
  expect(() => assertFreshClientBuild(root, dist, {})).toThrow("stale");
});

it("compares effective public process configuration without storing its values", () => {
  const { root, dist } = fixture();
  const env = {
    VITE_HTTP_URL: "https://old.example.test",
    T3CODE_CLERK_PUBLISHABLE_KEY: "public-test-key",
  };
  writeClientBuildStamp(root, dist, env);
  expect(() => assertFreshClientBuild(root, dist, { ...env })).not.toThrow();
  expect(() =>
    assertFreshClientBuild(root, dist, { ...env, VITE_HTTP_URL: "https://new.example.test" }),
  ).toThrow("stale");
  expect(() =>
    assertFreshClientBuild(root, dist, { ...env, T3CODE_CLERK_PUBLISHABLE_KEY: "changed-key" }),
  ).toThrow("stale");
  const stamp = readFileSync(join(dist, ".t3-build.json"), "utf8");
  expect(stamp).not.toContain("example.test");
  expect(stamp).not.toContain("public-test-key");
});

it("normalizes equivalent aliases, whitespace and unrelated private environment changes", () => {
  const { root } = fixture();
  expect(
    clientConfigurationFingerprint(root, {
      T3CODE_CLERK_PUBLISHABLE_KEY: "  public-key  ",
      PRIVATE_TOKEN: "a",
    }),
  ).toBe(
    clientConfigurationFingerprint(root, {
      VITE_CLERK_PUBLISHABLE_KEY: "public-key",
      PRIVATE_TOKEN: "b",
    }),
  );
});

it("detects effective root env-file changes and respects process overrides", () => {
  const { root, dist } = fixture();
  writeFileSync(join(root, ".env"), "T3CODE_HOSTED_APP_URL=https://first.example.test\n");
  writeClientBuildStamp(root, dist, {});
  writeFileSync(join(root, ".env.local"), "T3CODE_HOSTED_APP_URL=https://second.example.test\n");
  expect(() => assertFreshClientBuild(root, dist, {})).toThrow("stale");
  const override = { T3CODE_HOSTED_APP_URL: "https://override.example.test" };
  writeClientBuildStamp(root, dist, override);
  writeFileSync(join(root, ".env.local"), "T3CODE_HOSTED_APP_URL=https://third.example.test\n");
  expect(() => assertFreshClientBuild(root, dist, override)).not.toThrow();
});
