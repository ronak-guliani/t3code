import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  MAX_PULL_REQUEST_MONITOR_FINDING_BYTES,
  MAX_PULL_REQUEST_MONITOR_FINDINGS_BYTES,
  MAX_PULL_REQUEST_MONITOR_FINDINGS,
  PullRequestMonitorFinding,
  PullRequestMonitorFindings,
  PullRequestMonitorSubmitFindingsInput,
} from "./pullRequestMonitor.ts";

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const finding = { title: "Finding", severity: "major" as const, detail: "" };
const atLimit = {
  ...finding,
  detail: "a".repeat(MAX_PULL_REQUEST_MONITOR_FINDING_BYTES - bytes(finding)),
};

describe("review finding submission limits", () => {
  it("preserves an exact-limit body and rejects one additional UTF-8 byte", () => {
    expect(bytes(atLimit)).toBe(MAX_PULL_REQUEST_MONITOR_FINDING_BYTES);
    expect(Schema.decodeUnknownSync(PullRequestMonitorFinding)(atLimit).detail).toBe(
      atLimit.detail,
    );
    expect(Schema.is(PullRequestMonitorFinding)({ ...atLimit, detail: `${atLimit.detail}a` })).toBe(
      false,
    );
    expect(
      Schema.is(PullRequestMonitorFinding)({
        ...atLimit,
        detail: `${atLimit.detail.slice(0, -1)}é`,
      }),
    ).toBe(false);
  });

  it("counts JSON escaping and metadata, not just description characters", () => {
    expect(Schema.is(PullRequestMonitorFinding)({ ...finding, detail: "\n".repeat(40_000) })).toBe(
      false,
    );
    expect(Schema.is(PullRequestMonitorFinding)({ ...atLimit, key: "extra" })).toBe(false);
  });

  it("bounds the complete batch bytes and finding count", () => {
    const batch = [atLimit, atLimit, atLimit, { ...atLimit, detail: atLimit.detail.slice(0, -5) }];
    expect(bytes(batch)).toBe(MAX_PULL_REQUEST_MONITOR_FINDINGS_BYTES);
    expect(Schema.is(PullRequestMonitorFindings)(batch)).toBe(true);
    expect(Schema.is(PullRequestMonitorFindings)([atLimit, atLimit, atLimit, atLimit])).toBe(false);
    expect(
      Schema.is(PullRequestMonitorFindings)(
        Array.from({ length: MAX_PULL_REQUEST_MONITOR_FINDINGS }, () => finding),
      ),
    ).toBe(true);
    expect(
      Schema.is(PullRequestMonitorFindings)(
        Array.from({ length: MAX_PULL_REQUEST_MONITOR_FINDINGS + 1 }, () => finding),
      ),
    ).toBe(false);
    expect(
      Schema.is(PullRequestMonitorSubmitFindingsInput)({
        reference: { projectId: "project", repository: "acme/app", number: 1 },
        reviewThreadId: "review",
        findings: [atLimit, atLimit, atLimit, atLimit],
      }),
    ).toBe(false);
  });

  it("allows equal or ascending provenance lines but rejects reversed ranges", () => {
    const provenance = {
      findingId: "f",
      reviewedHeadSha: "head",
      diffHash: "diff",
      path: "a.ts",
      side: "new",
      startLine: 10,
      endLine: 10,
    };
    expect(Schema.is(PullRequestMonitorFinding)({ ...finding, provenance })).toBe(true);
    expect(
      Schema.is(PullRequestMonitorFinding)({
        ...finding,
        provenance: { ...provenance, endLine: 20 },
      }),
    ).toBe(true);
    expect(
      Schema.is(PullRequestMonitorFinding)({
        ...finding,
        provenance: { ...provenance, startLine: 20 },
      }),
    ).toBe(false);
  });
});
