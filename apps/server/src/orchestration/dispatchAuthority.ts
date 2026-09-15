import type {
  ChildNudgeUpdate,
  DispatchReportVerdict,
  QueuedTurnId,
  ThreadDelegation,
} from "@t3tools/contracts";

export type DispatchVerdict = DispatchReportVerdict;
export type RecordedReportOutcome = Extract<DispatchVerdict, "accepted" | "stale">;
export type DelegationExecutionReason = "assigned" | "continued" | "replaced";

export function activeDispatchId(delegation: ThreadDelegation): string | null {
  return delegation.dispatchId ?? null;
}

export function activeDispatchTurnId(delegation: ThreadDelegation): string | null {
  return (delegation.dispatchTurnId as string | null | undefined) ?? null;
}

/**
 * Fences an attempt-scoped child report against the delegation's active
 * execution generation.
 *
 * Identity model: the logical assignment survives retries; the dispatch
 * identifies one authorized execution; the turn proves which execution is
 * reporting. Provenance must arrive WITH the report from the reporting
 * execution's context — the classifier never substitutes live thread state.
 *
 * - `accepted`: authoritative execution (or genuinely pre-fence history).
 * - `stale`: superseded execution, missing proof, unminted claim, or novel
 *   report on closed work. No task, wait, or queue mutation.
 */
export function classifyChildReport(input: {
  readonly delegation: ThreadDelegation;
  readonly claimedDispatchId: string | null | undefined;
  readonly claimedTurnId: string | null | undefined;
  readonly kind: "progress" | "decision-needed" | "important-update";
  readonly recordedOutcome?: RecordedReportOutcome | undefined;
}): DispatchVerdict {
  if (input.recordedOutcome !== undefined) {
    return input.recordedOutcome;
  }
  if (input.delegation.completedAt !== null) {
    return "stale";
  }
  const activeTurn = activeDispatchTurnId(input.delegation);
  if (activeTurn === null) {
    const activeDispatch = activeDispatchId(input.delegation);
    // A minted dispatch with no bound turn cannot authorize state changes.
    // This covers both the initial startup window and replacement windows:
    // only session binding can establish the execution's authoritative pair.
    if (
      input.claimedDispatchId !== null &&
      input.claimedDispatchId !== undefined &&
      input.claimedDispatchId !== activeDispatch
    ) {
      return "stale";
    }
    if (activeDispatch !== null) {
      return input.kind === "progress" ? "accepted" : "stale";
    }
    return "accepted";
  }
  if (input.claimedTurnId === null || input.claimedTurnId === undefined) {
    // Turn-absent callers (pre-fence integrations) cannot prove execution.
    // Progress mutates nothing, so history stays complete; anything that
    // would mutate task state requires proof.
    return input.kind === "progress" ? "accepted" : "stale";
  }
  if (input.claimedTurnId !== activeTurn) {
    return "stale";
  }
  if (
    input.claimedDispatchId !== null &&
    input.claimedDispatchId !== undefined &&
    input.claimedDispatchId !== activeDispatchId(input.delegation)
  ) {
    return "stale";
  }
  return "accepted";
}

/**
 * Mints a fresh execution generation. The dispatch identifies one authorized
 * execution; the sequence orders generations for audit. Callers bind the
 * generation to a concrete turn via dispatchTurnId separately.
 */
export function mintDispatch(
  previousSequence?: number | null | undefined,
): readonly [dispatchId: string, dispatchSequence: number] {
  return [crypto.randomUUID(), (previousSequence ?? 0) + 1];
}

/**
 * Fresh execution generation for a newly created delegation. The turn
 * binding happens at the first session update (see execution binding),
 * so new work never silently enters the legacy path.
 */
export function mintDispatchRecord(previousSequence?: number | null | undefined): {
  readonly dispatchId: string;
  readonly dispatchSequence: number;
  readonly dispatchTurnId: null;
  readonly dispatchReason: "assigned";
} {
  const [dispatchId, dispatchSequence] = mintDispatch(previousSequence);
  return { dispatchId, dispatchSequence, dispatchTurnId: null, dispatchReason: "assigned" };
}

export function transitionDelegationExecution(
  delegation: ThreadDelegation,
  reason: Exclude<DelegationExecutionReason, "assigned">,
): {
  readonly delegation: ThreadDelegation;
  readonly retiredPendingResponseQueuedTurnId: QueuedTurnId | null;
} {
  const previousDispatchId = delegation.dispatchId;
  const previousSequence = delegation.dispatchSequence ?? (delegation.dispatchId ? 1 : 0);
  const [dispatchId, dispatchSequence] = mintDispatch(previousSequence);
  return {
    delegation: {
      ...delegation,
      dispatchId,
      dispatchSequence,
      dispatchTurnId: null,
      dispatchReason: reason,
      ...(previousDispatchId ? { previousDispatchId } : {}),
      decision: null,
      pendingResponse: null,
      outcome: undefined,
    },
    retiredPendingResponseQueuedTurnId: delegation.pendingResponse?.queuedTurnId ?? null,
  };
}

export function bindDelegationExecution(
  delegation: ThreadDelegation,
  turnId: NonNullable<ThreadDelegation["dispatchTurnId"]>,
): ThreadDelegation {
  return { ...delegation, dispatchTurnId: turnId };
}

export function reportBelongsToDelegation(
  report: ChildNudgeUpdate,
  delegation: ThreadDelegation,
): boolean {
  return (
    report.assignmentId === delegation.assignmentId &&
    (report.dispatchId === undefined ||
      delegation.dispatchId === undefined ||
      report.dispatchId === delegation.dispatchId)
  );
}
/**
 * Idempotency key for a logical report. The exact pre-fence format is kept
 * when no dispatch is involved so reports accepted before the upgrade and
 * retried afterward still deduplicate instead of waking the parent twice.
 */
export function childReportDedupeKey(input: {
  readonly childThreadId: string;
  readonly dispatchId: string | null | undefined;
  readonly originTurnId?: string | null | undefined;
  readonly assignmentId: string;
  readonly reportId: string;
}): string {
  if (input.dispatchId === null || input.dispatchId === undefined) {
    if (input.originTurnId !== null && input.originTurnId !== undefined) {
      return `report:${input.childThreadId}:turn:${input.originTurnId}:${input.assignmentId}:${input.reportId}`;
    }
    return `report:${input.childThreadId}:${input.assignmentId}:${input.reportId}`;
  }
  return `report:${input.childThreadId}:${input.dispatchId}:${input.assignmentId}:${input.reportId}`;
}

/**
 * Legacy rendering of a fenced update id (`report:child:assignment:report`),
 * for inputs that predate execution generations: hardcoded supersede
 * references and pre-upgrade receipts. The dispatch segment is a known
 * prefix built from the update's own fields, so stripping it is exact.
 */
export function legacyUpdateId(input: {
  readonly id: string;
  readonly childThreadId: string;
  readonly dispatchId: string | null | undefined;
  readonly assignmentId: string;
}): string | null {
  if (input.dispatchId === null || input.dispatchId === undefined) {
    return null;
  }
  const prefix = `report:${input.childThreadId}:${input.dispatchId}:${input.assignmentId}:`;
  if (!input.id.startsWith(prefix)) {
    return null;
  }
  return `report:${input.childThreadId}:${input.assignmentId}:${input.id.slice(prefix.length)}`;
}
