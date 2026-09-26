import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  classifySelfTestLock,
  parseSelfTestCommand,
  redactSelfTestText,
  selfTestBlockers,
  selfTestStatus,
  SelfTestManifest,
  type SelfTestManifest as SelfTestManifestType,
} from "./selfTestEvidence.ts";

const revision = { commit: "abc", contentHash: "def" };
const decodeManifest = Schema.decodeUnknownSync(SelfTestManifest);
const manifest: SelfTestManifestType = {
  version: 2,
  runId: "run",
  revision,
  status: "passed",
  stage: "passed",
  startedAt: "2026-09-12T00:00:00Z",
  completedAt: "2026-09-12T00:01:00Z",
  command: "pnpm test:direct-connect-smoke",
  process: {
    role: "child",
    pid: 42,
    command: "pnpm test:direct-connect-smoke",
    startedAt: "2026-09-12T00:00:01Z",
  },
  environment: {
    baseDirectory: "/tmp/self-test",
    webTarget: "/tmp/self-test/web",
    origin: "http://127.0.0.1:1234",
  },
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
  artifacts: [
    { file: "capture.json", sha256: "c", sizeBytes: 200 },
    { file: "diagnostics.json", sha256: "d", sizeBytes: 100 },
  ],
};

describe("pairing/reconnect baseline result model", () => {
  it("requires smoke assertions, diagnostics, and verified media", () => {
    expect(selfTestBlockers(manifest, revision)).toEqual([]);
  });
  it.each(["commit", "contentHash"] as const)("invalidates changed %s", (field) => {
    expect(selfTestBlockers(manifest, { ...revision, [field]: "new" })).toEqual([
      expect.objectContaining({ type: "stale-revision" }),
    ]);
    expect(selfTestStatus(manifest, { ...revision, [field]: "new" })).toBe("stale-revision");
  });
  it.each(["pending", "failed", "interrupted"] as const)(
    "never treats %s as verified",
    (status) => {
      expect(selfTestBlockers({ ...manifest, status }, revision)).not.toEqual([]);
    },
  );
  it("rejects missing or undecodable media", () => {
    expect(selfTestBlockers({ ...manifest, media: [] }, revision)).toHaveLength(2);
    expect(
      selfTestBlockers(
        { ...manifest, media: manifest.media.map((item) => ({ ...item, width: 0 })) },
        revision,
      ),
    ).toHaveLength(2);
    expect(
      selfTestBlockers(
        { ...manifest, media: manifest.media.map((item) => ({ ...item, durationSeconds: 0 })) },
        revision,
      ),
    ).toContainEqual(expect.objectContaining({ message: "Invalid baseline recording." }));
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
      ).toContainEqual(
        expect.objectContaining({
          message: "Browser diagnostics are missing or contain unexpected failures.",
        }),
      );
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
});

describe("self-test lifecycle and ownership", () => {
  const owner = {
    pid: 42,
    runId: "run",
    command: "pnpm test:self",
    startedAt: "2026-09-12T00:00:00Z",
  };
  it("only recovers a lock after verifying the owner is dead", () => {
    expect(classifySelfTestLock(owner, true, true)).toMatchObject({ status: "active" });
    expect(classifySelfTestLock(owner, false, false)).toMatchObject({ status: "stale" });
    expect(classifySelfTestLock(owner, true, false)).toMatchObject({ status: "ambiguous" });
    expect(classifySelfTestLock(undefined, false, false)).toMatchObject({ status: "ambiguous" });
    expect(
      classifySelfTestLock({ ...owner, startIdentity: "same" }, true, true, true),
    ).toMatchObject({ status: "active" });
    expect(
      classifySelfTestLock({ ...owner, startIdentity: "same" }, true, true, false),
    ).toMatchObject({ status: "stale" });
    expect(
      classifySelfTestLock({ ...owner, startIdentity: "same" }, true, true, undefined),
    ).toMatchObject({ status: "ambiguous" });
  });
  it("redacts credentials from durable error text", () => {
    expect(
      redactSelfTestText(
        "failed at /pair#token=secret with Bearer abc.def and ?access_token=other",
      ),
    ).toBe("failed at /pair#token=[redacted] with Bearer [redacted] and ?access_token=[redacted]");
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
