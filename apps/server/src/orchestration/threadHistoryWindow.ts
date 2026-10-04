import {
  MessageId,
  OrchestrationReadThreadInputError,
  ThreadId,
  type OrchestrationThreadHistoryWindow,
  type TurnId,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import {
  INITIAL_THREAD_USER_TURN_LIMIT,
  OLDER_THREAD_PAGE_USER_TURN_LIMIT,
} from "@t3tools/shared/threadHistory";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

interface Anchor {
  readonly messageId: MessageId;
  readonly sequence: number | null;
  readonly rowId: number;
  readonly createdAt: string;
}

export interface ThreadHistorySelection {
  readonly lower: Anchor | null;
  readonly upper: Anchor | null;
  readonly turnIds: readonly TurnId[];
  readonly beforeCursor: string | null;
  readonly hasMore: boolean;
}

const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  threadId: ThreadId,
  messageId: MessageId,
});
const decodeCursor = Schema.decodeUnknownSync(Cursor);

// All message queries use the same sequence/rowid ordering as full snapshots.
// Cursors contain stable IDs, not rowids: the current rowid is re-read so VACUUM
// or a revert cannot silently shift the page's anchor.
export function messageWindowPredicate(
  sql: SqlClient.SqlClient,
  selection: Pick<ThreadHistorySelection, "lower" | "upper">,
) {
  const { lower, upper } = selection;
  const after =
    lower === null
      ? sql`1`
      : lower.sequence === null
        ? sql`(messages.sequence IS NOT NULL OR (messages.sequence IS NULL AND messages.rowid >= ${lower.rowId}))`
        : sql`(messages.sequence > ${lower.sequence} OR (messages.sequence = ${lower.sequence} AND messages.rowid >= ${lower.rowId}))`;
  const before =
    upper === null
      ? sql`1`
      : upper.sequence === null
        ? sql`(messages.sequence IS NULL AND messages.rowid < ${upper.rowId})`
        : sql`(messages.sequence IS NULL OR messages.sequence < ${upper.sequence} OR (messages.sequence = ${upper.sequence} AND messages.rowid < ${upper.rowId}))`;
  return sql`(${after}) AND (${before})`;
}

export const selectThreadHistoryWindow = Effect.fn("selectThreadHistoryWindow")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  window: OrchestrationThreadHistoryWindow,
) {
  const limit =
    window.turnLimit ??
    (window.beforeCursor === undefined
      ? INITIAL_THREAD_USER_TURN_LIMIT
      : OLDER_THREAD_PAGE_USER_TURN_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return yield* new OrchestrationReadThreadInputError({
      message: "History turnLimit must be between 1 and 100.",
    });
  }
  let upper: Anchor | null = null;
  if (window.beforeCursor !== undefined) {
    const parsed = yield* Effect.try({
      try: () => {
        if (window.beforeCursor!.length > 2048 || !/^[\w-]+$/.test(window.beforeCursor!))
          throw new Error();
        return decodeCursor(
          JSON.parse(Buffer.from(window.beforeCursor!, "base64url").toString("utf8")),
        );
      },
      catch: () =>
        new OrchestrationReadThreadInputError({ message: "Invalid thread history cursor." }),
    });
    if (parsed.threadId !== threadId) {
      return yield* new OrchestrationReadThreadInputError({
        message: "History cursor belongs to another thread.",
      });
    }
    const rows =
      yield* sql<Anchor>`SELECT message_id AS "messageId", sequence, rowid AS "rowId", created_at AS "createdAt"
      FROM projection_thread_messages WHERE thread_id = ${threadId} AND message_id = ${parsed.messageId} AND role = 'user'`;
    upper = rows[0] ?? null;
    if (upper === null)
      return yield* new OrchestrationReadThreadInputError({
        message: "History changed; reload this thread before loading earlier turns.",
      });
  }
  const sequenced =
    upper?.sequence === null
      ? []
      : yield* sql<Anchor>`SELECT messages.message_id AS "messageId", messages.sequence,
      messages.rowid AS "rowId", messages.created_at AS "createdAt"
    FROM projection_thread_messages AS messages
    WHERE messages.thread_id = ${threadId} AND messages.role = 'user' AND messages.sequence IS NOT NULL
      AND ${messageWindowPredicate(sql, { lower: null, upper })}
    ORDER BY messages.sequence DESC, messages.rowid DESC LIMIT ${limit + 1}`;
  const legacy =
    sequenced.length > limit
      ? []
      : yield* sql<Anchor>`SELECT messages.message_id AS "messageId", messages.sequence,
      messages.rowid AS "rowId", messages.created_at AS "createdAt"
    FROM projection_thread_messages AS messages
    WHERE messages.thread_id = ${threadId} AND messages.role = 'user' AND messages.sequence IS NULL
      AND ${messageWindowPredicate(sql, { lower: null, upper })}
    ORDER BY messages.rowid DESC LIMIT ${limit + 1 - sequenced.length}`;
  const anchors = [...sequenced, ...legacy];
  const hasMore = anchors.length > limit;
  const lower = hasMore ? (anchors.slice(0, limit).at(-1) ?? null) : null;
  const selected = { lower, upper };
  const turns = yield* sql<{ readonly turnId: TurnId }>`
    WITH window_messages AS (
      SELECT messages.message_id, messages.turn_id FROM projection_thread_messages AS messages
      WHERE messages.thread_id = ${threadId} AND ${messageWindowPredicate(sql, selected)}
    )
    SELECT DISTINCT turn_id AS "turnId" FROM window_messages WHERE turn_id IS NOT NULL
    UNION
    SELECT turns.turn_id AS "turnId" FROM projection_turns AS turns
    WHERE turns.thread_id = ${threadId} AND turns.turn_id IS NOT NULL
      AND turns.pending_message_id IN (SELECT message_id FROM window_messages)
  `;
  return {
    ...selected,
    turnIds: turns.map((turn) => turn.turnId),
    hasMore,
    beforeCursor:
      hasMore && lower !== null
        ? Buffer.from(
            JSON.stringify({ version: 1, threadId, messageId: lower.messageId }),
          ).toString("base64url")
        : null,
  } satisfies ThreadHistorySelection;
});
