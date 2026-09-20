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
    });

    expect(result.readiness).toBe("No known blockers");
    expect(result.readiness).not.toBe("Ready now");
  });
});
