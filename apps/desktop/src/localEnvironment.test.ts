import { mkdtemp, mkdir, realpath, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectLocalEnvironment } from "@t3tools/shared/localEnvironment";
import { prepareLocalAttachment } from "./localEnvironment.ts";
import { verifyLocalEnvironmentOwnership } from "./localEnvironmentOwnership.ts";

vi.mock("./localEnvironmentOwnership.ts", () => ({
  verifyLocalEnvironmentOwnership: vi.fn(),
}));

let directory: string;
let cliEntry: string;
const descriptor = {
  environmentId: "test-local",
  label: "Test host",
  serverVersion: "0.0.23",
  platform: { os: "windows", arch: "x64" },
  capabilities: {},
};
beforeEach(async () => {
  vi.mocked(verifyLocalEnvironmentOwnership).mockResolvedValue(undefined);
  directory = await realpath(await mkdtemp(join(tmpdir(), "t3-attach-test-")));
  cliEntry = join(directory, "fixture.mjs");
  await mkdir(join(directory, "userdata"), { mode: 0o700 });
  await writeFile(join(directory, "userdata", "environment-id"), descriptor.environmentId, {
    mode: 0o600,
  });
  await writeFile(
    join(directory, "userdata", "server-runtime.json"),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      origin: "http://127.0.0.1:13773",
      startedAt: "2026-09-10T00:00:00Z",
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(descriptor)),
  );
  await writeFile(
    cliEntry,
    `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(join(directory, "credential-issued"))}, "");
    console.log(JSON.stringify({ credential: "test-only-credential" }));
  `,
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

async function attach(appVersion = descriptor.serverVersion) {
  const environment = await inspectLocalEnvironment(directory);
  if (!environment) throw new Error("Missing test environment");
  return prepareLocalAttachment({ environment, cliEntry, appVersion });
}
describe("desktop attachment", () => {
  it("does not issue credentials when OS ownership verification fails", async () => {
    vi.mocked(verifyLocalEnvironmentOwnership).mockRejectedValue(
      new Error("Ownership not verified"),
    );
    await expect(attach()).rejects.toThrow("Ownership not verified");
    await expect(access(join(directory, "credential-issued"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("uses a verified existing local endpoint and a private short-lived credential", async () => {
    expect(await attach()).toEqual({
      origin: "http://127.0.0.1:13773",
      credential: "test-only-credential",
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:13773/.well-known/t3/environment",
      expect.objectContaining({ redirect: "error" }),
    );
  });
  it("refuses version mismatches before authorizing", async () => {
    await expect(attach("other-version")).rejects.toThrow("versions differ");
  });
  it("rejects endpoint identity mismatches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...descriptor, environmentId: "other" })),
    );
    await expect(attach()).rejects.toThrow("no longer reachable");
  });
  it("does not leak child process output on failure", async () => {
    await writeFile(cliEntry, 'console.log("test-secret-never-log"); process.exit(1);');
    await expect(attach()).rejects.toThrow("Could not authorize");
    await expect(attach()).rejects.not.toThrow("test-secret-never-log");
  });
  it("does not leak malformed credential responses through schema errors", async () => {
    await writeFile(cliEntry, 'console.log(JSON.stringify({ secret: "test-secret-never-log" }));');
    await expect(attach()).rejects.toThrow("invalid pairing response");
    await expect(attach()).rejects.not.toThrow("test-secret-never-log");
  });
});
