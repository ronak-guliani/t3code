import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSelfTestContext, preflightSelfTestEnvironment } from "./selfTestCapture.ts";

describe("self-test capture finalization", () => {
  let output: string;
  const diagnostics = {
    consoleErrors: 1,
    expectedConsoleErrors: 0,
    failedRequests: 2,
    pageErrors: 0,
  };
  beforeEach(async () => {
    output = await mkdtemp(join(tmpdir(), "t3-capture-finalization-"));
  });
  afterEach(async () => {
    await rm(output, { recursive: true, force: true });
  });

  it("writes diagnostics after shutdown fails and preserves the shutdown error", async () => {
    const error = new Error("browser crashed");
    await expect(
      closeSelfTestContext(
        {
          close: async () => {
            throw error;
          },
        },
        output,
        diagnostics,
      ),
    ).rejects.toBe(error);
    expect(JSON.parse(await readFile(join(output, "diagnostics.json"), "utf8"))).toEqual(
      diagnostics,
    );
  });

  it("reports both errors when shutdown and diagnostics persistence fail", async () => {
    const error = new Error("browser crashed");
    await expect(
      closeSelfTestContext(
        {
          close: async () => {
            throw error;
          },
        },
        join(output, "missing"),
        diagnostics,
      ),
    ).rejects.toMatchObject({
      errors: [error, expect.objectContaining({ code: "ENOENT" })],
    });
  });

  it("does not hide diagnostics write failures after successful shutdown", async () => {
    await expect(
      closeSelfTestContext({ close: async () => {} }, join(output, "missing"), diagnostics),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks a missing static target before any backend request", async () => {
    await expect(
      preflightSelfTestEnvironment({
        baseDirectory: output,
        configuredBaseDirectory: output,
        runtimeStatePath: join(output, "userdata", "server-runtime.json"),
        staticDirectory: join(output, "missing-web"),
        origin: "http://127.0.0.1:1",
      }),
    ).rejects.toMatchObject({
      issue: { type: "web-target-missing" },
    });
  });

  it("checks backend health, app serving, and base-directory identity before pairing", async () => {
    const staticDirectory = join(output, "web");
    await mkdir(staticDirectory);
    await writeFile(join(staticDirectory, "index.html"), '<html><div id="root"></div></html>');
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      return url.endsWith("/api/auth/session")
        ? new Response("", { status: 401 })
        : new Response('<html><div id="root"></div></html>', {
            status: 200,
            headers: { "content-type": "text/html" },
          });
    }) as typeof fetch;
    try {
      await expect(
        preflightSelfTestEnvironment({
          baseDirectory: output,
          configuredBaseDirectory: output,
          runtimeStatePath: join(output, "userdata", "server-runtime.json"),
          staticDirectory,
          origin: "http://127.0.0.1:1234",
        }),
      ).resolves.toBeUndefined();
      expect(requests).toEqual(["http://127.0.0.1:1234/api/auth/session", "http://127.0.0.1:1234"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
