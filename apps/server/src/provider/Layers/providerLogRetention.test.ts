import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { pruneProviderLogs } from "./providerLogRetention.ts";

describe("pruneProviderLogs", () => {
  it("removes expired provider logs, then oldest files until the global byte quota is met", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-retention-"));
    const oldLogPath = path.join(directory, "thread-old.log.1");
    const middleLogPath = path.join(directory, "thread-middle.log");
    const latestLogPath = path.join(directory, "provider-events.ndjson");
    const unrelatedPath = path.join(directory, "settings.json");

    try {
      fs.writeFileSync(oldLogPath, "o".repeat(10));
      fs.writeFileSync(middleLogPath, "m".repeat(20));
      fs.writeFileSync(latestLogPath, "n".repeat(30));
      fs.writeFileSync(unrelatedPath, "x".repeat(100));
      fs.utimesSync(oldLogPath, 10, 10);
      fs.utimesSync(middleLogPath, 60, 60);
      fs.utimesSync(latestLogPath, 99, 99);

      const result = pruneProviderLogs({
        directory,
        maxBytes: 40,
        maxAgeMs: 50_000,
        nowMs: 100_000,
      });

      expect(result).toEqual({ filesRemoved: 2, bytesRemoved: 30, bytesRemaining: 30 });
      expect(fs.existsSync(oldLogPath)).toBe(false);
      expect(fs.existsSync(middleLogPath)).toBe(false);
      expect(fs.existsSync(latestLogPath)).toBe(true);
      expect(fs.existsSync(unrelatedPath)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats a missing log directory as an empty quota", () => {
    const directory = path.join(os.tmpdir(), `missing-provider-logs-${crypto.randomUUID()}`);

    expect(
      pruneProviderLogs({
        directory,
        maxBytes: 1024,
        maxAgeMs: 1_000,
        nowMs: 1_000,
      }),
    ).toEqual({ filesRemoved: 0, bytesRemoved: 0, bytesRemaining: 0 });
  });
});
