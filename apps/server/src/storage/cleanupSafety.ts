import type { OrchestrationThreadShell, TerminalSummary } from "@t3tools/contracts";
import { Effect } from "effect";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { TerminalManagerShape } from "../terminal/Services/Manager.ts";

/** Runtime facts that the projection alone cannot answer. */
export interface CleanupRuntimeSnapshot {
  /** Null when sessions could not be listed; unknown runtime state blocks cleanup. */
  readonly providerSessionThreadIds: ReadonlySet<string> | null;
  readonly terminals: ReadonlyArray<TerminalSummary>;
}

export const readCleanupRuntimeSnapshot = (input: {
  readonly providerService: Pick<ProviderServiceShape, "listSessions">;
  readonly terminalManager: Pick<TerminalManagerShape, "subscribeMetadata">;
}): Effect.Effect<CleanupRuntimeSnapshot> =>
  Effect.gen(function* () {
    const sessions = yield* input.providerService
      .listSessions()
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    let terminals: ReadonlyArray<TerminalSummary> = [];
    const unsubscribe = yield* input.terminalManager.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") terminals = event.terminals;
      }),
    );
    unsubscribe();
    return {
      providerSessionThreadIds:
        sessions === null ? null : new Set(sessions.map((session) => session.threadId)),
      terminals,
    };
  });

/**
 * Every rule that keeps a chat's workspace or terminals in use. Ages are not
 * part of this: a reset ignores them, the safety rules never.
 */
export function threadCleanupBlockers(
  thread: OrchestrationThreadShell,
  runtime: CleanupRuntimeSnapshot,
  options: { readonly terminalSubprocesses: boolean },
): ReadonlyArray<string> {
  const blockers: string[] = [];
  if (thread.pinnedAt != null) blockers.push("chat is pinned");
  if (thread.session?.activeTurnId != null || thread.latestTurn?.state === "running") {
    blockers.push("a turn is running");
  }
  if (thread.pendingTurnStart != null) blockers.push("a turn is starting");
  if (thread.hasPendingQueuedTurn) blockers.push("a message is queued");
  if (thread.hasPendingApprovals) blockers.push("an approval is pending");
  if (thread.hasPendingUserInput) blockers.push("user input is pending");
  if (runtime.providerSessionThreadIds === null) {
    blockers.push("provider sessions could not be checked");
  } else if (runtime.providerSessionThreadIds.has(thread.id)) {
    blockers.push("provider session is active");
  }
  if (
    options.terminalSubprocesses &&
    runtime.terminals.some(
      (terminal) => terminal.threadId === thread.id && terminal.hasRunningSubprocess,
    )
  ) {
    blockers.push("a terminal subprocess is running");
  }
  return blockers;
}
