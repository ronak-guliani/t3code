import type {
  CollaborativeAcceptanceProjection,
  PullRequestMonitorStatusResult,
} from "@t3tools/contracts";

export type PullRequestOrthogonalStatus = {
  readonly execution: string;
  readonly collaboration: string;
  readonly acceptance: string;
  readonly readiness: string;
  readonly blocker: string | null;
};

export function presentCollaborativeAcceptanceStatus(input: {
  readonly monitor: PullRequestMonitorStatusResult | null | undefined;
  readonly projection?: CollaborativeAcceptanceProjection | null;
}): PullRequestOrthogonalStatus {
  const projection = input.projection;
  const monitor = input.monitor?.monitor;
  const readiness = monitor?.readiness;
  const automationReason = input.monitor?.automationReason;

  if (projection) {
    return {
      execution:
        projection.executionPhase === "paused"
          ? "Monitoring paused"
          : projection.executionPhase === "needs-human"
            ? "Needs human"
            : projection.executionPhase === "verifying"
              ? "Applying feedback"
              : "Working",
      collaboration:
        projection.collaborationStatus === "exchange-pending"
          ? "Request queued"
          : projection.collaborationStatus === "child-assessment-pending"
            ? "Waiting on child"
            : projection.collaborationStatus === "parent-assessment-pending"
              ? "Waiting on parent"
              : projection.collaborationStatus === "human-input-required"
                ? "Needs human"
                : projection.collaborationStatus === "changes-requested"
                  ? "Applying feedback"
                  : "Waiting automatically",
      acceptance:
        projection.acceptanceLifecycle === "accepted"
          ? "Accepted"
          : projection.acceptanceLifecycle === "monitoring"
            ? "Monitoring"
            : projection.acceptanceLifecycle === "awaiting-review"
              ? "Reviewing candidate"
              : projection.acceptanceLifecycle === "changes-requested"
                ? "Applying feedback"
                : "Working",
      readiness:
        projection.readiness === "ready-now"
          ? "Ready now"
          : projection.readiness === "no-known-blockers"
            ? "No known blockers"
            : "Blocked",
      blocker: projection.reasons[0] ?? null,
    };
  }

  const readyNow = readiness?.ready === true && readiness.label === "ready-to-merge";
  return {
    execution:
      monitor?.status === "monitoring"
        ? "Working"
        : monitor?.status === "ready"
          ? "Monitoring"
          : monitor?.status === "stopped"
            ? "Monitoring paused"
            : "Needs human",
    collaboration:
      automationReason?.kind === "needs-human"
        ? "Needs human"
        : automationReason?.kind === "waiting-automatic"
          ? "Waiting automatically"
          : input.monitor?.ownerCandidates?.length
            ? "Request queued"
            : "No active exchange",
    acceptance: "Monitoring",
    readiness: readyNow
      ? "Ready now"
      : readiness?.label === "no-known-blockers"
        ? "No known blockers"
        : readiness
          ? "Blocked"
          : "Waiting for evidence",
    blocker:
      input.monitor?.automationBlockReason ??
      readiness?.blockers[0]?.detail ??
      readiness?.blockers[0]?.kind ??
      automationReason?.detail ??
      null,
  };
}
