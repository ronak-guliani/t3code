import { describe, expect, it } from "vitest";
import {
  replaceSelfTestSection,
  selfTestBlockers,
  type SelfTestManifest,
} from "./selfTestEvidence.ts";

const revision = { commit: "abc", contentHash: "def" };
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
  diagnostics: { pageErrors: 0, failedRequests: 0 },
  media: [
    {
      kind: "screenshot",
      file: "page.png",
      sha256: "a",
      sizeBytes: 100,
      width: 1200,
      height: 800,
      sampledFrames: 1,
      distinctFrames: 1,
    },
    {
      kind: "recording",
      file: "page.webm",
      sha256: "b",
      sizeBytes: 1000,
      width: 1200,
      height: 800,
      sampledFrames: 3,
      distinctFrames: 3,
      durationSeconds: 4,
    },
  ],
};

describe("self-test readiness", () => {
  it("separates a passed local run from published evidence", () => {
    expect(selfTestBlockers(manifest, revision, false)).toEqual([]);
    expect(selfTestBlockers(manifest, revision, true)).toHaveLength(3);
  });
  it("invalidates changed commits and dirty content", () => {
    expect(selfTestBlockers(manifest, { ...revision, commit: "new" }, false)).toContainEqual(
      expect.stringContaining("stale"),
    );
    expect(selfTestBlockers(manifest, { ...revision, contentHash: "new" }, false)).toContainEqual(
      expect.stringContaining("stale"),
    );
  });
  it.each(["running", "failed"] as const)("never treats %s as verified", (status) => {
    expect(selfTestBlockers({ ...manifest, status }, revision, false)).not.toEqual([]);
  });
  it("rejects missing, empty, and unsampled media", () => {
    expect(selfTestBlockers({ ...manifest, media: [] }, revision, false)).toHaveLength(2);
    expect(
      selfTestBlockers(
        {
          ...manifest,
          media: manifest.media.map((item) => ({ ...item, width: 0, sampledFrames: 0 })),
        },
        revision,
        false,
      ),
    ).toHaveLength(2);
  });
  it("rejects static recordings and unexpected browser failures", () => {
    expect(
      selfTestBlockers(
        {
          ...manifest,
          media: manifest.media.map((media) => ({ ...media, distinctFrames: 1 })),
        },
        revision,
        false,
      ),
    ).toContain("Invalid recording capture.");
    expect(
      selfTestBlockers(
        {
          ...manifest,
          diagnostics: { pageErrors: 1, failedRequests: 0 },
        },
        revision,
        false,
      ),
    ).toContain("Browser diagnostics are missing or contain unexpected failures.");
  });
  it("updates only the managed PR section without duplicate attachments", () => {
    const body = replaceSelfTestSection("Human description", "first");
    const updated = replaceSelfTestSection(body, "second");
    expect(updated).toContain("Human description");
    expect(updated).not.toContain("first");
    expect(replaceSelfTestSection(updated, "second")).toBe(updated);
  });
  it("rejects an incomplete PR section instead of overwriting prose", () => {
    expect(() => replaceSelfTestSection("Human <!-- t3-self-test:start -->", "new")).toThrow(
      "ambiguous",
    );
  });
});
