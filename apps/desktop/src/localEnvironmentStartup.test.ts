import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectLocalEnvironment, type LocalEnvironment } from "@t3tools/shared/localEnvironment";
import { assertDesktopCanOwnEnvironment } from "./localEnvironmentStartup.ts";

const offline: LocalEnvironment = {
  baseDir: "/test",
  environmentId: "test",
  label: "Test",
  status: "offline",
  origin: null,
  pid: null,
  startedAt: null,
  serverVersion: null,
  error: null,
};
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("desktop environment startup boundary", () => {
  it("permits a new or stopped environment for desktop-owned startup", () => {
    expect(() => assertDesktopCanOwnEnvironment(null)).not.toThrow();
    expect(() => assertDesktopCanOwnEnvironment(offline)).not.toThrow();
  });
  it("refuses unavailable evidence without falling back", () => {
    expect(() =>
      assertDesktopCanOwnEnvironment({
        ...offline,
        status: "unavailable",
        error: "Identity changed",
      }),
    ).toThrow("Identity changed");
  });
  it("refuses even a matching public descriptor and live PID before privileged attachment", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "t3-impostor-listener-")));
    const stateDir = join(directory, "userdata");
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(join(stateDir, "environment-id"), "test", { mode: 0o600 });
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          environmentId: "test",
          label: "Test",
          serverVersion: "0.0.23",
          platform: { os: "windows", arch: "x64" },
          capabilities: {},
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test listener");
      await writeFile(
        join(stateDir, "server-runtime.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          origin: `http://127.0.0.1:${address.port}`,
          startedAt: "2026-09-10T00:00:00Z",
        }),
        { mode: 0o600 },
      );
      const discovered = await inspectLocalEnvironment(directory);
      expect(discovered?.status).toBe("online");
      expect(() => assertDesktopCanOwnEnvironment(discovered)).toThrow(
        "Automatic desktop attachment is disabled",
      );
      expect(requests).toEqual(["/.well-known/t3/environment"]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
