import {
  MessageId,
  OrchestrationReadThreadInputError,
  ThreadId,
  OrchestrationThreadHistoryWindow,
  type TurnId,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import {
  INITIAL_THREAD_USER_TURN_LIMIT,
  OLDER_THREAD_PAGE_USER_TURN_LIMIT,
} from "@t3tools/shared/threadHistory";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { encodeThreadHistoryCursor } from "@t3tools/shared/threadHistoryState";

/** Strip subscribe-only options; absence retains the legacy eager snapshot. */
export function threadHistoryWindowOptions(
  input: OrchestrationThreadHistoryWindow,
): OrchestrationThreadHistoryWindow | undefined {
  const { turnLimit, beforeCursor, aroundMessageId } = input;
  return turnLimit === undefined && beforeCursor === undefined && aroundMessageId === undefined
    ? undefined
    : {
        ...(turnLimit === undefined ? {} : { turnLimit }),
        ...(beforeCursor === undefined ? {} : { beforeCursor }),
        ...(aroundMessageId === undefined ? {} : { aroundMessageId }),
      };
}

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
  readonly userOrigins: Record<string, { sequence: number | null; rowId: number }>;
}

const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  threadId: ThreadId,
  messageId: MessageId,
});
const decodeCursor = Schema.decodeUnknownSync(Cursor);
const decodeHistoryWindow = Schema.decodeUnknownSync(OrchestrationThreadHistoryWindow);

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
        : sql`(messages.sequence,messages.rowid) >= (${lower.sequence},${lower.rowId})`;
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
  yield* Effect.try({
    try: () => decodeHistoryWindow(window),
    catch: () =>
      new OrchestrationReadThreadInputError({ message: "Invalid thread history window." }),
  });
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
        reason: "history-cursor-stale",
      });
  }
  if (window.aroundMessageId !== undefined) {
    const target = (yield* sql<
      Anchor & { pendingMessageId: string | null }
    >`SELECT messages.message_id AS "messageId",messages.sequence,messages.rowid AS "rowId",messages.created_at AS "createdAt",
      turns.pending_message_id AS "pendingMessageId" FROM projection_thread_messages messages
      LEFT JOIN projection_turns turns ON turns.thread_id=messages.thread_id AND turns.turn_id=messages.turn_id
      WHERE messages.thread_id=${threadId} AND messages.message_id=${window.aroundMessageId}`)[0];
    if (!target)
      return yield* new OrchestrationReadThreadInputError({
        message: "Historical message was not found in this thread.",
      });
    const anchor =
      target.pendingMessageId !== null
        ? (yield* sql<Anchor>`SELECT message_id AS "messageId",sequence,rowid AS "rowId",created_at AS "createdAt" FROM projection_thread_messages WHERE thread_id=${threadId} AND message_id=${target.pendingMessageId} AND role='user'`)[0]
        : (yield* sql<Anchor>`SELECT messages.message_id AS "messageId",messages.sequence,messages.rowid AS "rowId",messages.created_at AS "createdAt" FROM projection_thread_messages messages
          WHERE messages.thread_id=${threadId} AND messages.role='user' AND ${messageWindowPredicate(sql, { lower: null, upper: { ...target, rowId: target.rowId + 1 } })}
          ORDER BY messages.sequence IS NOT NULL DESC,messages.sequence DESC,messages.rowid DESC LIMIT 1`)[0];
    upper =
      anchor === undefined
        ? ((yield* sql<Anchor>`SELECT messages.message_id AS "messageId",messages.sequence,messages.rowid AS "rowId",messages.created_at AS "createdAt" FROM projection_thread_messages messages
      WHERE messages.thread_id=${threadId} AND messages.role='user' ORDER BY messages.sequence IS NOT NULL,messages.sequence,messages.rowid LIMIT 1`)[0] ??
          null)
        : ((yield* sql<Anchor>`SELECT messages.message_id AS "messageId",messages.sequence,messages.rowid AS "rowId",messages.created_at AS "createdAt" FROM projection_thread_messages messages
      WHERE messages.thread_id=${threadId} AND messages.role='user' AND messages.message_id<>${anchor.messageId} AND ${messageWindowPredicate(sql, { lower: anchor, upper: null })}
      ORDER BY messages.sequence IS NOT NULL,messages.sequence,messages.rowid LIMIT 1`)[0] ?? null);
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
  const selectedAnchors = anchors.slice(0, limit);
  const lower = hasMore ? (selectedAnchors.at(-1) ?? null) : null;
  const selected = { lower, upper };
  // NULL segments of sequenced users need ownership, but ordinary sequenced
  // and all-NULL legacy replies keep their provenance range (including steering).
  const turns = yield* sql<{ readonly turnId: TurnId }>`
    WITH window_users AS MATERIALIZED (
      SELECT messages.message_id, messages.turn_id FROM projection_thread_messages AS messages
      WHERE messages.thread_id = ${threadId}
        AND ${sql.in(
          "messages.message_id",
          selectedAnchors.map((anchor) => anchor.messageId),
        )}
    )
    SELECT DISTINCT turn_id AS "turnId" FROM window_users WHERE turn_id IS NOT NULL
    UNION
    SELECT turns.turn_id AS "turnId" FROM window_users
    CROSS JOIN projection_turns AS turns ON turns.thread_id=${threadId} AND turns.pending_message_id=window_users.message_id
    WHERE turns.turn_id IS NOT NULL
    UNION
    SELECT DISTINCT messages.turn_id AS "turnId" FROM projection_thread_messages AS messages
    WHERE messages.thread_id = ${threadId} AND messages.role <> 'user' AND messages.turn_id IS NOT NULL
      AND ${messageWindowPredicate(sql, selected)} AND (messages.sequence IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM projection_turns AS owner
        JOIN projection_thread_messages AS user_message
          ON user_message.thread_id = owner.thread_id
            AND user_message.message_id = owner.pending_message_id AND user_message.role = 'user'
            AND user_message.sequence IS NOT NULL
        WHERE owner.thread_id = messages.thread_id AND owner.turn_id = messages.turn_id
      ))
  `;
  return {
    ...selected,
    turnIds: turns.map((turn) => turn.turnId),
    userOrigins: Object.fromEntries(
      selectedAnchors.map((anchor) => [
        anchor.messageId,
        { sequence: anchor.sequence, rowId: anchor.rowId },
      ]),
    ),
    hasMore,
    beforeCursor:
      hasMore && lower !== null ? encodeThreadHistoryCursor(threadId, lower.messageId) : null,
  } satisfies ThreadHistorySelection;
});
