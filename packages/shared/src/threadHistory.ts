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
  M extends { id: string; createdAt: string; role?: string | undefined },
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
  messageOrigins?: {
    older: Readonly<Record<string, { sequence: number | null; rowId: number }>>;
    loaded: Readonly<Record<string, { sequence: number | null; rowId: number }>>;
  },
) {
  const byTimeId = (a: { id: string; createdAt: string }, b: { id: string; createdAt: string }) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const mergeOrderedMessages = (): M[] => {
    if (!messageOrigins)
      return prependHistoryRows(older.messages, loaded.messages, (row) => row.id);

    type MessageOrigin = { sequence: number | null; rowId: number };
    const messagePositions = (
      rows: readonly M[],
      origins: Readonly<Record<string, MessageOrigin>>,
    ) => {
      let turnOrigin: MessageOrigin | undefined;
      return rows.map((message) => {
        if (message.role === "user") turnOrigin = origins[message.id];
        return { message, origin: turnOrigin };
      });
    };
    const seen = new Set(loaded.messages.map((row) => row.id));
    const olderRows = messagePositions(older.messages, messageOrigins.older).filter(
      ({ message }) => {
        if (seen.has(message.id)) return false;
        seen.add(message.id);
        return true;
      },
    );
    const loadedRows = messagePositions(loaded.messages, messageOrigins.loaded);
    const compareOrigin = (left: MessageOrigin, right: MessageOrigin): number => {
      if (left.sequence === null && right.sequence !== null) return -1;
      if (left.sequence !== null && right.sequence === null) return 1;
      if (left.sequence !== null && right.sequence !== null && left.sequence !== right.sequence)
        return left.sequence - right.sequence;
      return left.rowId - right.rowId;
    };
    const result: M[] = [];
    let olderIndex = 0;
    let loadedIndex = 0;
    while (olderIndex < olderRows.length && loadedIndex < loadedRows.length) {
      const olderPosition = olderRows[olderIndex]!.origin;
      const loadedPosition = loadedRows[loadedIndex]!.origin;
      if (
        olderPosition === undefined ||
        (loadedPosition !== undefined && compareOrigin(olderPosition, loadedPosition) < 0)
      ) {
        result.push(olderRows[olderIndex++]!.message);
      } else {
        // Equal positions are the same user turn. Keep the already-applied live
        // rows first; overlaps were removed from incoming above.
        result.push(loadedRows[loadedIndex++]!.message);
      }
    }
    return result.concat(
      olderRows.slice(olderIndex).map(({ message }) => message),
      loadedRows.slice(loadedIndex).map(({ message }) => message),
    );
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
