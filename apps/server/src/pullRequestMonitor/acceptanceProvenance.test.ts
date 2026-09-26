import { describe, expect, it } from "vitest";

import {
  CollaborativeAcceptanceCandidateId,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceExchangeId,
  PullRequestMonitorFeedbackItemId,
  PullRequestMonitorFeedbackRevisionId,
  PullRequestMonitorId,
} from "@t3tools/contracts";

import { buildMonitorAcceptanceProvenance } from "./acceptanceProvenance.ts";

describe("buildMonitorAcceptanceProvenance", () => {
  it("copies and freezes all revision-bound acceptance evidence", () => {
    const required = ["diff", "threads"];
    const provenance = buildMonitorAcceptanceProvenance({
      monitorId: PullRequestMonitorId.make("monitor-1"),
      findingId: PullRequestMonitorFeedbackItemId.make("finding-1"),
      findingRevisionId: PullRequestMonitorFeedbackRevisionId.make("revision-1"),
      provenance: {
        caseId: CollaborativeAcceptanceCaseId.make("case-1"),
        candidateId: CollaborativeAcceptanceCandidateId.make("candidate-1"),
        transportContext: {
          caseId: CollaborativeAcceptanceCaseId.make("case-1"),
          exchangeId: CollaborativeAcceptanceExchangeId.make("exchange-1"),
        },
        headSha: "head-1",
        sourceRevision: "provider-revision-1",
        workflow: { identity: "review-workflow", version: "2" },
        requiredCoverage: {
          required,
          covered: ["diff"],
          applicability: "known",
        },
        diffHash: "diff-1",
        location: {
          path: "src/example.ts",
          side: "new",
          startLine: 4,
          endLine: 5,
        },
      },
    });

    required.push("checks");

    expect(provenance.requiredCoverage.required).toEqual(["diff", "threads"]);
    expect(provenance).toMatchObject({
      monitorId: "monitor-1",
      caseId: "case-1",
      candidateId: "candidate-1",
      headSha: "head-1",
      sourceRevision: "provider-revision-1",
      findingId: "finding-1",
      findingRevisionId: "revision-1",
      workflow: { identity: "review-workflow", version: "2" },
      diffHash: "diff-1",
    });
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(Object.isFrozen(provenance.requiredCoverage)).toBe(true);
    expect(Object.isFrozen(provenance.requiredCoverage.required)).toBe(true);
    expect(provenance.location !== null && Object.isFrozen(provenance.location)).toBe(true);
  });
});
