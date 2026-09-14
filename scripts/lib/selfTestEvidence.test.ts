import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { parseSelfTestCommand, selfTestBlockers, SelfTestManifest } from "./selfTestEvidence.ts";

const revision = { commit: "abc", contentHash: "def" };
const decodeManifest = Schema.decodeUnknownSync(SelfTestManifest);
const manifest: SelfTestManifest = {
  version: 1,
  runId: "run",
  revision,
  status: "passed",
  startedAt: "2026-09-12T00:00:00Z",
  completedAt: "2026-09-12T00:01:00Z",
  command: "pnpm test:direct-connect-smoke",
  exitCode: 0,
  scenarios: ["One-time pairing survives reload"],
  diagnostics: { pageErrors: 0, failedRequests: 0, consoleErrors: 0, expectedConsoleErrors: 1 },
  media: [
    { kind: "screenshot", file: "page.png", sha256: "a", sizeBytes: 100, width: 1200, height: 800 },
    {
      kind: "recording",
      file: "page.webm",
      sha256: "b",
      sizeBytes: 1000,
      width: 1200,
      height: 800,
      durationSeconds: 4,
    },
  ],
};

describe("pairing/reconnect baseline", () => {
  it("requires smoke assertions and diagnostics, not feature reports or publication", () => {
    expect(selfTestBlockers(manifest, revision)).toEqual([]);
  });
  it.each(["commit", "contentHash"] as const)("invalidates changed %s", (field) => {
    expect(selfTestBlockers(manifest, { ...revision, [field]: "new" })).toContainEqual(
      expect.stringContaining("stale"),
    );
  });
  it.each(["running", "failed"] as const)("never treats %s as verified", (status) => {
    expect(selfTestBlockers({ ...manifest, status }, revision)).not.toEqual([]);
  });
  it("rejects missing or undecodable media", () => {
    expect(selfTestBlockers({ ...manifest, media: [] }, revision)).toHaveLength(2);
    expect(
      selfTestBlockers(
        {
          ...manifest,
          media: manifest.media.map((item) => ({ ...item, width: 0 })),
        },
        revision,
      ),
    ).toHaveLength(2);
    expect(
      selfTestBlockers(
        {
          ...manifest,
          media: manifest.media.map((item) => ({ ...item, durationSeconds: 0 })),
        },
        revision,
      ),
    ).toContain("Invalid baseline recording.");
  });
  it.each(["consoleErrors", "pageErrors", "failedRequests"] as const)(
    "blocks unexpected %s",
    (field) => {
      expect(
        selfTestBlockers(
          {
            ...manifest,
            diagnostics: { ...manifest.diagnostics!, [field]: 1 },
          },
          revision,
        ),
      ).toContain("Browser diagnostics are missing or contain unexpected failures.");
    },
  );
  it("does not interpret missing console counts as zero", () => {
    expect(() =>
      decodeManifest({
        ...manifest,
        diagnostics: { pageErrors: 0, failedRequests: 0 },
      }),
    ).toThrow();
  });
  it("reads legacy captures without using frame diversity as a test result", () => {
    const legacy = decodeManifest({
      ...manifest,
      media: manifest.media.map((media) => ({ ...media, sampledFrames: 6, distinctFrames: 1 })),
      feature: { result: "passed" },
      publication: { pullRequestUrl: "https://github.com/owner/repo/pull/1" },
    });
    expect(selfTestBlockers(legacy, revision)).toEqual([]);
    expect(legacy).not.toHaveProperty("feature");
    expect(legacy).not.toHaveProperty("publication");
  });
});

describe("baseline-only CLI", () => {
  it("supports running and inspecting the baseline", () => {
    expect(parseSelfTestCommand([])).toBe("run");
    expect(parseSelfTestCommand(["run"])).toBe("run");
    expect(parseSelfTestCommand(["status"])).toBe("status");
  });
  it.each([
    ["feature", "report.json"],
    ["publish", "https://github.com/owner/repo/pull/1"],
    ["status", "--require-feature"],
    ["status", "--require-published"],
    ["status", "--unknown"],
  ])("rejects retired or unknown arguments %s %s", (...args) => {
    expect(() => parseSelfTestCommand(args)).toThrow("only tests pairing/reconnect");
  });
});
