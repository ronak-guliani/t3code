import type {
  DispatchReportVerdict,
  OrchestrationThread,
  ThreadDelegation,
} from "@t3tools/contracts";

export type DispatchVerdict = DispatchReportVerdict;

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
 * - `already-recorded`: the assignment closed and this exact report has a
 *   durable receipt. Acknowledge without a second wake.
 * - `stale`: superseded execution, missing proof, unminted claim, or novel
 *   report on closed work. No task, wait, or queue mutation.
 */
export function classifyChildReport(input: {
  readonly delegation: ThreadDelegation;
  readonly claimedDispatchId: string | null | undefined;
  readonly claimedTurnId: string | null | undefined;
  readonly kind: "progress" | "decision-needed" | "important-update";
  readonly hasReceipt: boolean;
}): DispatchVerdict {
  if (input.delegation.completedAt !== null) {
    return input.hasReceipt ? "already-recorded" : "stale";
  }
  const activeTurn = activeDispatchTurnId(input.delegation);
  if (activeTurn === null) {
    const activeDispatch = activeDispatchId(input.delegation);
    // Unbound generation (e.g. after `thread.dispatch.replace` clears the
    // bound turn): a superseded execution must not slip a state-changing
    // report through the window before the replacement turn binds. Dispatch
    // mismatch is checked before any turn acceptance, and turn-only reports
    // without dispatch proof stay diagnostic-only for anything beyond
    // progress once a replacement generation exists (sequence > 1). The
    // first generation keeps the legacy accept so pre-fence history and the
    // initial bind are not rejected.
    if (
      input.claimedDispatchId !== null &&
      input.claimedDispatchId !== undefined &&
      input.claimedDispatchId !== activeDispatch
    ) {
      return "stale";
    }
    const isReplacementGeneration = (input.delegation.dispatchSequence ?? 0) > 1;
    const hasDispatchProof =
      input.claimedDispatchId !== null &&
      input.claimedDispatchId !== undefined &&
      activeDispatch !== null &&
      input.claimedDispatchId === activeDispatch;
    if (
      isReplacementGeneration &&
      activeDispatch !== null &&
      !hasDispatchProof &&
      input.kind !== "progress"
    ) {
      return "stale";
    }
    if (input.claimedTurnId !== null && input.claimedTurnId !== undefined) {
      return "accepted";
    }
    if (input.claimedDispatchId !== null && input.claimedDispatchId !== undefined) {
      return "stale";
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
} {
  const [dispatchId, dispatchSequence] = mintDispatch(previousSequence);
  return { dispatchId, dispatchSequence, dispatchTurnId: null };
}
/**
 * Idempotency key for a logical report. The exact pre-fence format is kept
 * when no dispatch is involved so reports accepted before the upgrade and
 * retried afterward still deduplicate instead of waking the parent twice.
 */
export function childReportDedupeKey(input: {
  readonly childThreadId: string;
  readonly dispatchId: string | null | undefined;
  readonly assignmentId: string;
  readonly reportId: string;
}): string {
  if (input.dispatchId === null || input.dispatchId === undefined) {
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

function isDelegationReportedActivity(
  activity: OrchestrationThread["activities"][number],
): boolean {
  return (activity as { readonly kind?: unknown }).kind === "delegation.reported";
}

/**
 * Recovers whether this exact logical report already has a durable receipt,
 * so retried deliveries are acknowledged without re-mutating. Pre-fence
 * receipts carry no dispatch/assignment fields and match legacy queries.
 */
export function hasReportReceipt(
  thread: OrchestrationThread,
  input: {
    readonly reportId: string;
    readonly assignmentId: string | null | undefined;
    readonly dispatchId: string | null | undefined;
  },
): boolean {
  return thread.activities.some((activity) => {
    if (!isDelegationReportedActivity(activity)) {
      return false;
    }
    const payload = (activity.payload ?? {}) as {
      readonly reportId?: unknown;
      readonly assignmentId?: unknown;
      readonly dispatchId?: unknown;
    };
    if (payload.reportId !== input.reportId) {
      return false;
    }
    const receiptAssignment =
      typeof payload.assignmentId === "string" ? payload.assignmentId : null;
    const receiptDispatch = typeof payload.dispatchId === "string" ? payload.dispatchId : null;
    if (
      receiptAssignment !== null &&
      input.assignmentId !== null &&
      input.assignmentId !== undefined &&
      receiptAssignment !== input.assignmentId
    ) {
      return false;
    }
    if (receiptDispatch !== (input.dispatchId ?? null)) {
      return false;
    }
    return true;
  });
}
