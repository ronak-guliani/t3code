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
