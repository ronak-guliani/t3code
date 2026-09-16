import type { TurnId } from "@t3tools/contracts";

import type { ThreadFeedEntry, ThreadFeedLatestTurn } from "../../lib/threadActivity";

export function deriveTerminalAssistantMessageIds(
  feed: ReadonlyArray<ThreadFeedEntry>,
): ReadonlySet<string> {
  const terminalIdsByTurn = new Map<TurnId, string>();
  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {
      terminalIdsByTurn.set(entry.message.turnId, entry.message.id);
    }
  }
  return new Set(terminalIdsByTurn.values());
}

/**
 * LegendList needs a stable scalar that changes when turn completion metadata
 * changes, even if the message objects and list data do not.
 */
export function deriveAssistantMetadataInvalidationKey(
  latestTurn: ThreadFeedLatestTurn | null,
): string {
  if (latestTurn === null) {
    return "none";
  }
  return [latestTurn.turnId, latestTurn.state, latestTurn.completedAt ?? ""].join(":");
}

/** Mirrors web's user-message collapse threshold: long pastes collapse. */
export const USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD = 900;
/** Mirrors web's default normal-origin preview limit (10 lines). */
export const USER_MESSAGE_COLLAPSED_LINE_LIMIT = 10;

/**
 * Whether a user-sent message gets the collapsed preview with a
 * Show full message / Show less toggle. Mirrors web's
 * shouldCollapseUserMessage minus terminal contexts, which mobile renders
 * nowhere in the bubble.
 */
export function shouldCollapseUserMessageText(
  text: string,
  collapsedLineLimit: number = USER_MESSAGE_COLLAPSED_LINE_LIMIT,
): boolean {
  const trimmedText = text.trim();
  if (trimmedText.length >= USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD) {
    return true;
  }
  const lineCount = trimmedText.length === 0 ? 0 : trimmedText.split(/\r\n|\r|\n/).length;
  return lineCount > collapsedLineLimit;
}
