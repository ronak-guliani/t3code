import { describe, expect, it } from "vitest";

import { type DatabaseStats, evaluateAutomaticVacuum, GB } from "./databaseVacuum.ts";

// Failure modes: vacuuming for a trivial gain, filling a nearly full disk, or
// stalling live turns behind the rewrite.
const stats = (fileBytes: number, reclaimableBytes: number): DatabaseStats => ({
  fileBytes,
  walBytes: 0,
  pageSize: 4096,
  pageCount: fileBytes / 4096,
  freelistCount: reclaimableBytes / 4096,
  reclaimableBytes,
  incrementalAutoVacuum: false,
});
const decide = (input: Partial<Parameters<typeof evaluateAutomaticVacuum>[0]>) =>
  evaluateAutomaticVacuum({
    automaticCleanupEnabled: true,
    stats: stats(8 * GB, 4 * GB),
    freeDiskBytes: 100 * GB,
    busyReason: null,
    ...input,
  });

describe("evaluateAutomaticVacuum", () => {
  it("runs only above max(1 GB, 25% of the file)", () => {
    expect(decide({}).run).toBe(true);
    expect(decide({ stats: stats(8 * GB, 2 * GB) }).run).toBe(false);
    expect(decide({ stats: stats(2 * GB, GB) }).run).toBe(false);
    expect(decide({ stats: stats(2 * GB, 1.1 * GB) }).run).toBe(true);
  });

  it("requires free disk of twice the database size", () => {
    expect(decide({ freeDiskBytes: 15 * GB })).toEqual({
      run: false,
      reason: "needs free disk space of at least twice the database size",
    });
    expect(decide({ freeDiskBytes: null }).run).toBe(false);
    expect(decide({ freeDiskBytes: 16 * GB }).run).toBe(true);
  });

  it("never runs while live work or the master switch forbids it", () => {
    expect(decide({ busyReason: "1 chat has a running turn" })).toEqual({
      run: false,
      reason: "1 chat has a running turn",
    });
    expect(decide({ automaticCleanupEnabled: false }).run).toBe(false);
  });
});
