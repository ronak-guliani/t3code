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
