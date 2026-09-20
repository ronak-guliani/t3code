import { describe, expect, it } from "vitest";

import { presentCollaborativeAcceptanceStatus } from "./collaborativeAcceptancePresentation";

describe("presentCollaborativeAcceptanceStatus", () => {
  it("keeps execution and collaboration dimensions independent", () => {
    const result = presentCollaborativeAcceptanceStatus({
      monitor: {
        monitor: {
          status: "monitoring",
          readiness: null,
        } as never,
        ownerCandidates: [{ threadId: "child", title: "Child review" }],
      } as never,
      acceptance: null,
    });

    expect(result.execution).toBe("Working");
    expect(result.collaboration).toBe("Request queued");
  });

  it("does not claim ready now while evidence is incomplete", () => {
    const result = presentCollaborativeAcceptanceStatus({
      monitor: {
        monitor: {
          status: "monitoring",
          readiness: {
            ready: false,
            label: "no-known-blockers",
            blockers: [{ kind: "evidence-incomplete" }],
          },
          ownerCandidates: [],
        } as never,
      } as never,
      acceptance: null,
    });

    expect(result.readiness).toBe("No known blockers");
    expect(result.readiness).not.toBe("Ready now");
  });

  it("fails closed for provider refresh errors and terminal monitors", () => {
    const result = presentCollaborativeAcceptanceStatus({
      monitor: {
        monitor: {
          status: "error",
          readiness: {
            ready: true,
            label: "ready-to-merge",
            blockers: [],
          },
          lastError: "Provider unavailable",
        },
        latestSnapshot: null,
        automationReason: {
          kind: "monitoring-paused",
          code: "provider-failure",
          detail: "Provider unavailable",
        },
      } as never,
      acceptance: {
        record: {
          projection: {
            executionPhase: "monitoring",
            collaborationStatus: "none",
            acceptanceLifecycle: "accepted",
            readiness: "ready-now",
            reasons: [],
            headSha: "head-1",
          },
        },
      } as never,
    });

    expect(result.execution).toBe("Monitoring paused");
    expect(result.acceptance).toBe("Monitoring");
    expect(result.readiness).toBe("Blocked");
    expect(result.blocker).toBe("Provider unavailable");
  });

  it("does not treat a negative acceptance outcome as satisfied", () => {
    const result = presentCollaborativeAcceptanceStatus({
      monitor: null,
      acceptance: {
        record: {
          projection: {
            executionPhase: "needs-human",
            collaborationStatus: "human-input-required",
            acceptanceLifecycle: "changes-requested",
            readiness: "blocked",
            reasons: ["Parent assessment failed"],
            headSha: "head-1",
          },
        },
      } as never,
    });

    expect(result.acceptance).toBe("Applying feedback");
    expect(result.readiness).toBe("Blocked");
    expect(result.blocker).toBe("Parent assessment failed");
  });

  it("revokes readiness when the provider head moves", () => {
    const result = presentCollaborativeAcceptanceStatus({
      monitor: {
        monitor: {
          status: "ready",
          readiness: {
            ready: true,
            label: "ready-to-merge",
            blockers: [],
          },
          lastError: null,
        },
        latestSnapshot: {
          headSha: "head-2",
          completeness: {
            reviewsComplete: true,
            reviewThreadsComplete: true,
            issueCommentsComplete: true,
            checksComplete: true,
            requiredChecksKnown: true,
            baseComparisonKnown: true,
          },
        },
      } as never,
      acceptance: {
        record: {
          projection: {
            executionPhase: "monitoring",
            collaborationStatus: "none",
            acceptanceLifecycle: "accepted",
            readiness: "ready-now",
            reasons: [],
            headSha: "head-1",
          },
        },
      } as never,
    });

    expect(result.readiness).toBe("Blocked");
    expect(result.blocker).toContain("candidate head changed");
  });

  it("does not infer collaborative readiness from a monitor-only result", () => {
    const result = presentCollaborativeAcceptanceStatus({
      monitor: {
        monitor: {
          status: "ready",
          readiness: {
            ready: true,
            label: "ready-to-merge",
            blockers: [],
          },
          lastError: null,
        },
        latestSnapshot: null,
      } as never,
      acceptance: null,
    });

    expect(result.readiness).toBe("Waiting for evidence");
    expect(result.readiness).not.toBe("Ready now");
  });
});
