export const INITIAL_THREAD_USER_TURN_LIMIT = 10;
export const OLDER_THREAD_PAGE_USER_TURN_LIMIT = 20;

/** Older rows prepend; the already-applied live row always wins an overlap. */
export function prependHistoryRows<T>(
  older: readonly T[],
  loaded: readonly T[],
  key: (row: T) => string,
): T[] {
  const seen = new Set(loaded.map(key));
  return [...older.filter((row) => !seen.has(key(row))), ...loaded];
}
import type { OrchestrationEvent } from "@t3tools/contracts";

type TurnWindow = {
  messages: readonly { id: string; turnId?: string | null }[];
  latestTurn?: { turnId: string | null } | null;
  session?: { activeTurnId?: string | null | undefined } | null;
  pendingTurnStart?: unknown;
  checkpoints?: readonly { turnId: string }[];
  turnDiffSummaries?: readonly { turnId: string }[];
};

/** An unloaded turn's delta is not a complete message. Fetch its baseline first. */
export function isMessageOutsideHistory(
  thread: TurnWindow | null | undefined,
  event: OrchestrationEvent,
): boolean {
  if (
    !thread ||
    event.type !== "thread.message-sent" ||
    event.payload.role !== "assistant" ||
    event.payload.turnId === null
  )
    return false;
  if (
    thread.pendingTurnStart ||
    thread.latestTurn?.turnId === event.payload.turnId ||
    thread.session?.activeTurnId === event.payload.turnId
  )
    return false;
  return (
    !thread.messages.some(
      (message) =>
        message.turnId === event.payload.turnId || message.id === event.payload.messageId,
    ) &&
    !(thread.checkpoints ?? thread.turnDiffSummaries ?? []).some(
      (checkpoint) => checkpoint.turnId === event.payload.turnId,
    )
  );
}
