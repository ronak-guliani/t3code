import type { ThreadDelegation } from "@t3tools/contracts";

/**
 * Outcome of fencing an attempt-scoped child report against the delegation's
 * active execution generation.
 *
 * - `accepted`: the report comes from the currently authorized execution
 *   (or both sides predate fencing) and may mutate task/queue state.
 * - `already-recorded`: the assignment already completed. The report is
 *   acknowledged without a second wake so retried deliveries don't re-nudge.
 * - `stale`: a superseded (or unfenced-proof) execution reported late.
 *   The report must not mutate task, wait, or queue state.
 */
export type DispatchVerdict = "accepted" | "already-recorded" | "stale";

export function classifyChildReport(input: {
  readonly delegation: ThreadDelegation;
  readonly dispatchId: string | null | undefined;
}): DispatchVerdict {
  if (input.delegation.completedAt !== null) {
    return "already-recorded";
  }
  const active = input.delegation.dispatchId ?? null;
  const claimed = input.dispatchId ?? null;
  if (active === null && claimed === null) {
    return "accepted";
  }
  if (active === null) {
    return "accepted";
  }
  if (claimed === null) {
    return "stale";
  }
  return active === claimed ? "accepted" : "stale";
}

/**
 * Idempotency key for a logical report. The same report retried on the same
 * execution must not wake the parent twice; a report from a different
 * execution is a different key and goes through fencing first.
 */
export function childReportDedupeKey(input: {
  readonly childThreadId: string;
  readonly dispatchId: string | null | undefined;
  readonly assignmentId: string;
  readonly reportId: string;
}): string {
  const dispatch = input.dispatchId ?? "legacy";
  return `report:${input.childThreadId}:${dispatch}:${input.assignmentId}:${input.reportId}`;
}
