import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSelfTestContext } from "./selfTestCapture.ts";

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
});
