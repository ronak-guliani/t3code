import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";

import {
  assertConnectConfig,
  installCliPackage,
  resolveCliLink,
  waitForConnect,
} from "./install-t3-cli.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "t3-cli-install-"));
  directories.push(home);
  const bin = join(home, "bin");
  await mkdir(bin);
  return { home, bin, link: join(bin, "t3") };
}

it("waits for relay readiness instead of reporting successful authorization as online", async () => {
  const states = ["link-pending", "linked-offline", "linked-online"];
  let reads = 0;
  await waitForConnect(
    () => JSON.stringify({ state: states[reads++] }),
    async () => {},
  );
  expect(reads).toBe(3);
});

it("fails when background setup remains offline", async () => {
  let waits = 0;
  await expect(
    waitForConnect(
      () => '{"state":"linked-offline"}',
      async () => {
        waits += 1;
      },
    ),
  ).rejects.toThrow("did not come online");
  expect(waits).toBe(30);
});

it("rejects incomplete authorization and malformed status", async () => {
  await expect(waitForConnect(() => '{"state":"not-authenticated"}')).rejects.toThrow("incomplete");
  await expect(waitForConnect(() => "{}")).rejects.toThrow("invalid Connect status");
});

it.skipIf(process.platform === "win32")(
  "replaces the actual shell symlink rather than pnpm's injected workspace command",
  async () => {
    const { home, bin, link } = await fixture();
    const workspaceBin = join(home, "repo", "node_modules", ".bin");
    await mkdir(workspaceBin, { recursive: true });
    await writeFile(join(workspaceBin, "t3"), "workspace wrapper");
    await symlink("/missing/old-cli", link);
    expect(await resolveCliLink([workspaceBin, bin].join(delimiter), home)).toBe(link);
  },
);

it("selects a user bin directory for a first installation", async () => {
  const { home, bin, link } = await fixture();
  expect(await resolveCliLink(bin, home)).toBe(link);
});

it("refuses to replace regular executable files", async () => {
  const { home, bin, link } = await fixture();
  await writeFile(link, "owned by another installer");
  await expect(resolveCliLink(bin, home)).rejects.toThrow("Refusing to replace");
});

it.skipIf(process.platform === "win32")(
  "activates only a runnable snapshot that survives removal of its source",
  async () => {
    const { home, link } = await fixture();
    const source = join(home, "source");
    await mkdir(join(source, "dist", "client"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(source, "dist", "bin.mjs"), 'console.log("installed-cli");');
    await writeFile(join(source, "dist", "client", "index.html"), "client");
    // Real CLI packages always have dependencies; exercise the normal snapshot layout.
    await mkdir(join(source, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(source, "node_modules", "dependency", "package.json"), "{}");
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ dependencies: { dependency: "*" } }),
    );
    await symlink("/previous/cli", link);
    const entry = await installCliPackage(source, join(home, "installs"), link);
    await rm(source, { recursive: true });
    expect(await readlink(link)).toBe(entry);
    expect(execFileSync(process.execPath, [entry], { encoding: "utf8" })).toContain(
      "installed-cli",
    );
  },
);

it.skipIf(process.platform === "win32")(
  "leaves the previous CLI intact if the copied bundle cannot load",
  async () => {
    const { home, link } = await fixture();
    const source = join(home, "source");
    await mkdir(join(source, "dist"), { recursive: true });
    await writeFile(join(source, "package.json"), '{"dependencies":{"missing-dependency":"*"}}');
    await writeFile(join(source, "dist", "bin.mjs"), "process.exit(1)");
    await symlink("/previous/cli", link);
    await expect(installCliPackage(source, join(home, "installs"), link)).rejects.toThrow();
    expect(await readlink(link)).toBe("/previous/cli");
  },
);

it.skipIf(process.platform === "win32")(
  "refuses a bin directory that resolves outside the home directory",
  async () => {
    const { home } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "t3-cli-outside-"));
    directories.push(outside);
    const escaped = join(home, "escaped-bin");
    await symlink(outside, escaped);
    await expect(resolveCliLink(escaped, home)).rejects.toThrow("No user-owned bin directory");
  },
);

it("rejects relay URLs and Clerk keys the runtime would refuse", () => {
  const valid = {
    relayUrl: "https://relay.example.test",
    clerkPublishableKey: `pk_test_${btoa("clerk.example.test$")}`,
    clerkCliOAuthClientId: "client-id",
  };
  expect(() => assertConnectConfig(valid)).not.toThrow();
  expect(() => assertConnectConfig({ ...valid, relayUrl: "http://relay.example.test" })).toThrow(
    "T3CODE_RELAY_URL",
  );
  expect(() =>
    assertConnectConfig({ ...valid, relayUrl: "https://relay.example.test/path" }),
  ).toThrow("T3CODE_RELAY_URL");
  expect(() => assertConnectConfig({ ...valid, clerkPublishableKey: "not-a-key" })).toThrow(
    "T3CODE_CLERK_PUBLISHABLE_KEY",
  );
});
