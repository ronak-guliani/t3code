export const INITIAL_THREAD_USER_TURN_LIMIT = 10;
export const OLDER_THREAD_PAGE_USER_TURN_LIMIT = 20;

/** Older rows prepend; the already-applied live row always wins an overlap. */
export function prependHistoryRows<T>(
  older: readonly T[],
  loaded: readonly T[],
  key: (row: T) => string,
): T[] {
  const seen = new Set(loaded.map(key));
  return [
    ...older.filter((row) => {
      const id = key(row);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
    ...loaded,
  ];
}

/** One merge policy for both clients, including targeted/non-contiguous pages.
 * Live rows win overlaps; message wire order is preserved. */
export function mergeHistoryCollections<
  M extends { id: string; createdAt: string },
  A extends { id: string; createdAt: string },
  P extends { id: string; createdAt: string },
  C extends { turnId: string; checkpointTurnCount?: number | null | undefined },
>(
  older: {
    messages: readonly M[];
    activities: readonly A[];
    proposedPlans: readonly P[];
    checkpoints: readonly C[];
  },
  loaded: {
    messages: readonly M[];
    activities: readonly A[];
    proposedPlans: readonly P[];
    checkpoints: readonly C[];
  },
) {
  const byTimeId = (a: { id: string; createdAt: string }, b: { id: string; createdAt: string }) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const mergeOrderedMessages = (): M[] => {
    const liveIds = new Set(loaded.messages.map((row) => row.id));
    const incoming = older.messages.filter((row) => !liveIds.has(row.id));
    const result: M[] = [];
    let olderIndex = 0;
    let loadedIndex = 0;
    while (olderIndex < incoming.length && loadedIndex < loaded.messages.length) {
      if (
        incoming[olderIndex]!.createdAt.localeCompare(loaded.messages[loadedIndex]!.createdAt) <= 0
      ) {
        result.push(incoming[olderIndex++]!);
      } else {
        result.push(loaded.messages[loadedIndex++]!);
      }
    }
    return result.concat(incoming.slice(olderIndex), loaded.messages.slice(loadedIndex));
  };
  return {
    messages: mergeOrderedMessages(),
    activities: prependHistoryRows(older.activities, loaded.activities, (r) => r.id).sort(byTimeId),
    proposedPlans: prependHistoryRows(older.proposedPlans, loaded.proposedPlans, (r) => r.id).sort(
      byTimeId,
    ),
    checkpoints: prependHistoryRows(older.checkpoints, loaded.checkpoints, (r) => r.turnId).sort(
      (a, b) =>
        (a.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
        (b.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
    ),
  };
}
