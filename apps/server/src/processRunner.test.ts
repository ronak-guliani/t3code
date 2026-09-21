import { describe, expect, it } from "vitest";

import { isWindowsCommandNotFound, runProcess } from "./processRunner.ts";

describe("runProcess", () => {
  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], { maxBufferBytes: 128 }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
      maxBufferBytes: 128,
      outputMode: "truncate",
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it("rejects before spawning when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runProcess("node", ["-e", "process.exit(0)"], { signal: controller.signal }),
    ).rejects.toThrow("aborted before it started");
  });

  it("terminates a running child when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = runProcess("node", ["-e", "setTimeout(() => {}, 20_000)"], {
      signal: controller.signal,
      timeoutMs: 15_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    controller.abort();
    // Without the abort kill the child would sleep past the test timeout.
    await expect(pending).rejects.toThrow("aborted");
  }, 10_000);
});

describe("isWindowsCommandNotFound", () => {
  it("matches the localized German cmd.exe error text", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      expect(
        isWindowsCommandNotFound(
          1,
          "wird nicht als interner oder externer Befehl, betriebsfahiges Programm oder Batch-Datei erkannt",
        ),
      ).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
