import {
  EventId,
  MessageId,
  OrchestrationThreadDetailSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import { mergeHistoryCollections } from "@t3tools/shared/threadHistory";
import {
  encodeThreadHistoryCursor,
  historyCursorAfterTrim,
} from "@t3tools/shared/threadHistoryState";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const TestLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(RepositoryIdentityResolverLive),
  Layer.provideMerge(SqlitePersistenceMemory),
);
const threadId = ThreadId.make("history-window");
const now = "2026-10-04T00:00:00.000Z";
const encodeDetailSnapshot = Schema.encodeSync(OrchestrationThreadDetailSnapshot);
const decodeDetailSnapshot = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot);

// Windowing must happen in SQL, before large or invalid historical JSON is
// decoded. Stable message anchors must also survive legacy NULL sequences,
// equal timestamps, complete multi-segment turns, and mixed live state.
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('history-project', 'History', '/tmp/history', '[]', ${now}, ${now})
  `;
  yield* sql`
    INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, latest_turn_id, created_at, updated_at)
    VALUES (${threadId}, 'history-project', 'Long history', '{"instanceId":"codex","model":"gpt-5.4"}',
      'full-access', 'default', 'turn-35', ${now}, ${now})
  `;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, sequence, role, text,
    attachments_json, is_streaming, created_at, updated_at)
    VALUES ('history-intro', ${threadId}, 0, 'system', 'History introduction', '[]', 0, ${now}, ${now})`;
  for (let turn = 0; turn < 36; turn++) {
    const turnId = `turn-${turn}`;
    for (let segment = 0; segment < 3; segment++) {
      yield* sql`
        INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, sequence, role,
          text, attachments_json, is_streaming, created_at, updated_at)
        VALUES (${`message-${turn}-${segment}`}, ${threadId}, ${segment === 0 ? null : turnId},
          ${turn * 10 + segment + 1}, ${segment === 0 ? "user" : "assistant"},
          ${`Turn ${turn}, segment ${segment}`}, '[]', 0, ${now}, ${now})
      `;
    }
    yield* sql`
      INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, assistant_message_id,
        state, requested_at, started_at, completed_at, checkpoint_turn_count, checkpoint_ref,
        checkpoint_status, checkpoint_files_json)
      VALUES (${threadId}, ${turnId}, ${`message-${turn}-0`}, ${`message-${turn}-2`}, 'completed',
        ${now}, ${now}, ${now}, ${turn + 1}, ${`refs/t3/${turn}`}, 'ready', '[]')
    `;
    yield* sql`
      INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, sequence,
        tone, kind, summary, payload_json, created_at)
      VALUES (${`activity-${turn}`}, ${threadId}, ${turnId}, ${turn * 10 + 4},
        'info', 'runtime.info', 'History activity', '{}', ${now})
    `;
  }
  yield* sql`
    INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, sequence,
      tone, kind, summary, payload_json, created_at)
    VALUES ('old-open-approval', ${threadId}, 'turn-0', 5, 'info', 'approval.requested',
      'Unresolved approval', '{"requestId":"pending-approval","requestKind":"command"}', ${now})
  `;
  yield* sql`
    INSERT INTO projection_queued_turns (queued_turn_id, thread_id, message_id, text,
      attachments_json, runtime_mode, interaction_mode, created_at, updated_at, queue_position)
    VALUES ('pending-queue', ${threadId}, 'pending-message', 'Pending follow-up', '[]',
      'full-access', 'default', ${now}, ${now}, 0)
  `;
});

it.effect("hydrates all selected turns with one bounded activity payload statement", () =>
  Effect.gen(function* () {
    yield* seed;
    const statements: string[] = [];
    const query = yield* ProjectionSnapshotQuery;
    const first = Option.getOrThrow(
      yield* query.getThreadDetailSnapshotById(threadId, { turnLimit: 10 }).pipe(
        Effect.provideService(Statement.CurrentTransformer, (self) =>
          Effect.sync(() => {
            statements.push(self.compile()[0]);
            return self;
          }),
        ),
      ),
    );
    assert.equal(first.thread.activities.length, 10);
    const payloadReads = statements.filter(
      (text) =>
        text.includes("activity_payload_blobs") &&
        text.includes('AS "activityId"') &&
        !text.includes("approval_ranked"),
    );
    assert.equal(payloadReads.length, 1);
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

it.effect("starts independent activity paging from a real head read", () =>
  Effect.gen(function* () {
    yield* seed;
    const query = yield* ProjectionSnapshotQuery;
    const first = yield* query.getThreadActivitiesPage({ threadId, limit: 5 });
    assert.equal(first.activities.length, 5);
    assert.isTrue(first.hasMore);
    const boundary = first.activities[0]!;
    const next = yield* query.getThreadActivitiesPage({
      threadId,
      limit: 5,
      beforeCreatedAt: boundary.createdAt,
      beforeActivityId: boundary.id,
    });
    assert.equal(next.activities.length, 5);
    assert.equal(new Set([...first.activities, ...next.activities].map((a) => a.id)).size, 10);
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

it.effect("bounds every visible turn before decoding a noisy turn's activity payloads", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`WITH RECURSIVE noisy(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM noisy WHERE n < 1200)
      INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,sequence,tone,kind,summary,payload_json,created_at)
      SELECT printf('noisy-%04d',n),${threadId},'turn-35',n,'info','runtime.info','Noisy turn','{}',${now} FROM noisy`;
    yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at)
      VALUES ('ancient-invalid',${threadId},'turn-35','info','runtime.info','Outside per-turn cap','not-json','2020-01-01T00:00:00.000Z')`;
    const snapshot = Option.getOrThrow(
      yield* (yield* ProjectionSnapshotQuery).getThreadDetailSnapshotById(threadId, {
        turnLimit: 10,
      }),
    );
    assert.equal(snapshot.thread.activities.filter((a) => a.turnId === "turn-35").length, 200);
    assert.equal(snapshot.thread.activities.length, 209);
    assert.isTrue(snapshot.thread.hasMoreActivities);
    assert.isTrue(snapshot.thread.hasMoreCurrentTurnActivities);
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

it.effect("does not assign session-sequence or legacy unscoped activities to message windows", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_thread_messages SET sequence = NULL WHERE sequence < 101`;
    for (const [id, sequence] of [
      ["unscoped-legacy", null],
      ["unscoped-session", 999],
    ] as const) {
      yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,sequence,tone,kind,summary,payload_json,created_at)
        VALUES (${id},${threadId},NULL,${sequence},'info','runtime.info','Unscoped context','{}',${now})`;
    }
    const query = yield* ProjectionSnapshotQuery;
    const first = Option.getOrThrow(
      yield* query.getThreadDetailSnapshotById(threadId, { turnLimit: 10 }),
    );
    const second = Option.getOrThrow(
      yield* query.getThreadDetailSnapshotById(threadId, {
        turnLimit: 20,
        beforeCursor: first.page!.beforeCursor!,
      }),
    );
    const last = Option.getOrThrow(
      yield* query.getThreadDetailSnapshotById(threadId, {
        turnLimit: 20,
        beforeCursor: second.page!.beforeCursor!,
      }),
    );
    for (const page of [first, second, last]) {
      assert.isTrue(page.thread.activities.every((activity) => activity.turnId !== null));
      assert.isTrue(page.thread.hasMoreActivities);
    }
    const activities = yield* query.getThreadActivitiesPage({
      threadId,
      limit: 200,
      beforeCreatedAt: "9999-01-01T00:00:00.000Z",
      beforeActivityId: EventId.make("~"),
    });
    assert.isTrue(activities.activities.some((a) => a.id === "unscoped-legacy"));
    assert.isTrue(activities.activities.some((a) => a.id === "unscoped-session"));
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

it.effect("loads a historical message's complete turn without fetching intervening history", () =>
  Effect.gen(function* () {
    yield* seed;
    const page = Option.getOrThrow(
      yield* (yield* ProjectionSnapshotQuery).getThreadDetailSnapshotById(threadId, {
        turnLimit: 10,
        aroundMessageId: MessageId.make("message-3-1"),
      }),
    );
    assert.isTrue(page.thread.messages.some((m) => m.id === "message-3-1"));
    assert.equal(page.thread.messages.length, 13);
    assert.equal(page.thread.checkpoints.length, 4);
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

for (const { name, legacyPrefix, nullMessages, expectedIds } of [
  {
    name: "a legacy requested segment",
    legacyPrefix: 0,
    nullMessages: ["message-3-1"],
    expectedIds: ["message-3-1", "message-3-0", "message-3-2"],
  },
  {
    name: "multiple legacy owned segments",
    legacyPrefix: 0,
    nullMessages: ["message-3-1", "message-3-2"],
    expectedIds: ["message-3-1", "message-3-2", "message-3-0"],
  },
  {
    name: "a legacy user with sequenced segments",
    legacyPrefix: 32,
    nullMessages: ["message-4-1"],
    expectedIds: ["message-3-0", "message-3-1", "message-3-2"],
  },
]) {
  it.effect(`loads only the complete owned target turn with ${name}`, () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_thread_messages SET sequence = NULL
        WHERE thread_id = ${threadId} AND (sequence < ${legacyPrefix} OR ${sql.in("message_id", nullMessages)})`;
      // An adjacent legacy segment must not bring its blobs or turn context
      // into the target window, even when its origin falls inside the range.
      yield* sql`UPDATE projection_thread_messages SET attachments_json = 'not-json'
        WHERE thread_id = ${threadId} AND message_id = 'message-4-1'`;
      yield* sql`UPDATE projection_turns SET checkpoint_files_json = 'not-json'
        WHERE thread_id = ${threadId} AND turn_id = 'turn-4'`;
      yield* sql`UPDATE projection_thread_activities SET payload_json = 'not-json'
        WHERE thread_id = ${threadId} AND activity_id = 'activity-4'`;
      const query = yield* ProjectionSnapshotQuery;
      const page = Option.getOrThrow(
        yield* query.getThreadDetailSnapshotById(threadId, {
          turnLimit: 1,
          aroundMessageId: MessageId.make("message-3-1"),
        }),
      );
      assert.deepEqual(
        page.thread.messages.map((message) => message.id),
        expectedIds,
      );
      assert.deepEqual(
        page.thread.activities.map((activity) => activity.id),
        ["activity-3"],
      );
      assert.deepEqual(
        page.thread.checkpoints.map((checkpoint) => checkpoint.turnId),
        ["turn-3"],
      );
      assert.deepEqual(Object.keys(page.page?.userOrigins ?? {}), ["message-3-0"]);
      assert.isTrue(page.page?.hasMore);
      assert.equal(page.page?.beforeCursor, encodeThreadHistoryCursor(threadId, "message-3-0"));

      const older = Option.getOrThrow(
        yield* query.getThreadDetailSnapshotById(threadId, {
          turnLimit: 1,
          beforeCursor: page.page!.beforeCursor!,
        }),
      );
      assert.deepEqual(
        older.thread.messages.map((message) => message.id),
        ["message-2-0", "message-2-1", "message-2-2"],
      );
      assert.equal(older.page?.beforeCursor, encodeThreadHistoryCursor(threadId, "message-2-0"));

      const oldest = Option.getOrThrow(
        yield* query.getThreadDetailSnapshotById(threadId, {
          turnLimit: 1,
          beforeCursor: encodeThreadHistoryCursor(threadId, "message-1-0"),
        }),
      );
      assert.deepEqual(
        oldest.thread.messages.map((message) => message.id),
        ["history-intro", "message-0-0", "message-0-1", "message-0-2"],
      );
      assert.isFalse(oldest.page?.hasMore);
      assert.isNull(oldest.page?.beforeCursor);
    }).pipe(Effect.provide(Layer.fresh(TestLayer))),
  );
}

it.effect("pages complete user-anchored turns without gaps while retaining live context", () =>
  Effect.gen(function* () {
    yield* seed;
    const query = yield* ProjectionSnapshotQuery;
    const first = Option.getOrThrow(
      yield* query.getThreadDetailSnapshotById(threadId, { turnLimit: 10 }),
    );
    assert.equal(first.thread.messages.length, 30);
    assert.equal(first.thread.messages[0]?.id, "message-26-0");
    assert.equal(first.thread.checkpoints.length, 10);
    assert.equal(first.thread.activities.length, 10);
    assert.isTrue(first.page?.hasMore);
    assert.equal(first.thread.queuedTurns?.[0]?.id, "pending-queue");
    assert.equal(first.thread.activityContext?.[0]?.id, "old-open-approval");

    const second = Option.getOrThrow(
      yield* query.getThreadDetailSnapshotById(threadId, {
        turnLimit: 20,
        beforeCursor: first.page!.beforeCursor!,
      }),
    );
    assert.equal(second.thread.messages.length, 60);
    assert.equal(second.thread.messages[0]?.id, "message-6-0");
    assert.equal(second.thread.checkpoints.length, 20);
    const third = Option.getOrThrow(
      yield* query.getThreadDetailSnapshotById(threadId, {
        turnLimit: 20,
        beforeCursor: second.page!.beforeCursor!,
      }),
    );
    assert.equal(third.thread.messages.length, 19);
    assert.equal(third.thread.messages[0]?.id, "history-intro");
    assert.isFalse(third.page?.hasMore);
    assert.isNull(third.page?.beforeCursor);
    const ids = [third, second, first].flatMap((page) =>
      page.thread.messages.map((message) => message.id),
    );
    assert.equal(new Set(ids).size, 109);
    const complete = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
    assert.deepEqual(
      ids,
      complete.messages.map((message) => message.id),
    );
    assert.equal(
      Option.getOrThrow(yield* query.getThreadDetailById(threadId, { unboundedMessages: true }))
        .messages.length,
      109,
    );
    const archive = yield* query.getActiveChatArchiveEntries();
    assert.equal(archive[0]?.thread.messages.length, 109);
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

it.effect("keeps persisted user origins inside the contract page through snapshot encoding", () =>
  Effect.gen(function* () {
    yield* seed;
    const query = yield* ProjectionSnapshotQuery;
    const firstSnapshot = Option.getOrThrow(
      yield* query.getThreadDetailSnapshotById(threadId, { turnLimit: 10 }),
    );
    const first = decodeDetailSnapshot(encodeDetailSnapshot(firstSnapshot));
    const olderSnapshot = Option.getOrThrow(
      yield* query.getThreadDetailSnapshotById(threadId, {
        turnLimit: 20,
        beforeCursor: first.page!.beforeCursor!,
      }),
    );
    const older = decodeDetailSnapshot(encodeDetailSnapshot(olderSnapshot));
    assert.equal(Object.keys(first.page?.userOrigins ?? {}).length, 10);
    assert.equal(Object.keys(older.page?.userOrigins ?? {}).length, 20);
    assert.isTrue(first.page?.userOrigins?.["message-26-0"] !== undefined);

    const widened = mergeHistoryCollections(
      {
        messages: older.thread.messages,
        activities: older.thread.activities,
        proposedPlans: older.thread.proposedPlans,
        checkpoints: older.thread.checkpoints,
      },
      {
        messages: first.thread.messages,
        activities: first.thread.activities,
        proposedPlans: first.thread.proposedPlans,
        checkpoints: first.thread.checkpoints,
      },
      {
        older: older.page?.userOrigins ?? {},
        loaded: first.page?.userOrigins ?? {},
      },
    );
    const widenedPage = {
      ...older.page!,
      userOrigins: { ...older.page?.userOrigins, ...first.page?.userOrigins },
    };
    const afterEviction = historyCursorAfterTrim(
      widenedPage,
      threadId,
      widened.messages.slice(3),
      3,
    );
    assert.isNotNull(afterEviction);
    assert.equal(afterEviction.beforeCursor, encodeThreadHistoryCursor(threadId, "message-7-0"));
    assert.isTrue(afterEviction.hasMore);
    assert.isTrue(afterEviction.userOrigins["message-7-0"] !== undefined);
    assert.isFalse(afterEviction.userOrigins["message-6-0"] !== undefined);
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

it.effect("does not decode out-of-window checkpoint payloads and supports legacy sequences", () =>
  Effect.gen(function* () {
    yield* seed;
    const query = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_turns SET checkpoint_files_json = 'invalid historical JSON'
      WHERE thread_id = ${threadId} AND checkpoint_turn_count <= 20`;
    yield* sql`UPDATE projection_thread_messages SET sequence = NULL WHERE thread_id = ${threadId}`;
    const first = Option.getOrThrow(
      yield* query.getThreadDetailSnapshotById(threadId, { turnLimit: 10 }),
    );
    assert.equal(first.thread.messages[0]?.id, "message-26-0");
    assert.equal(first.thread.messages.length, 30);
    assert.equal(first.thread.checkpoints.length, 10);
    const invalid = yield* query
      .getThreadDetailSnapshotById(threadId, { turnLimit: 10, beforeCursor: "not-a-cursor" })
      .pipe(Effect.flip);
    assert.equal(invalid._tag, "OrchestrationReadThreadInputError");
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);

it.effect("crosses mixed legacy boundaries and rejects deleted or foreign page anchors", () =>
  Effect.gen(function* () {
    yield* seed;
    const query = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_thread_messages SET sequence = NULL WHERE thread_id = ${threadId} AND sequence < 101`;
    const first = Option.getOrThrow(
      yield* query.getThreadDetailSnapshotById(threadId, { turnLimit: 10 }),
    );
    const middle = Option.getOrThrow(
      yield* query.getThreadDetailSnapshotById(threadId, {
        turnLimit: 20,
        beforeCursor: first.page!.beforeCursor!,
      }),
    );
    assert.equal(middle.thread.messages[0]?.id, "message-6-0");
    assert.equal(middle.thread.messages.length, 60);
    const last = Option.getOrThrow(
      yield* query.getThreadDetailSnapshotById(threadId, {
        turnLimit: 20,
        beforeCursor: middle.page!.beforeCursor!,
      }),
    );
    assert.equal(last.thread.messages[0]?.id, "history-intro");
    assert.equal(last.thread.messages.length, 19);
    const foreign = yield* query
      .getThreadDetailSnapshotById(ThreadId.make("another-thread"), {
        turnLimit: 10,
        beforeCursor: first.page!.beforeCursor!,
      })
      .pipe(Effect.flip);
    assert.equal(foreign._tag, "OrchestrationReadThreadInputError");
    yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'message-26-0'`;
    const removed = yield* query
      .getThreadDetailSnapshotById(threadId, {
        turnLimit: 10,
        beforeCursor: first.page!.beforeCursor!,
      })
      .pipe(Effect.flip);
    assert.equal(removed._tag, "OrchestrationReadThreadInputError");
    const invalidLimit = yield* query
      .getThreadDetailSnapshotById(threadId, { turnLimit: 0 })
      .pipe(Effect.flip);
    assert.equal(invalidLimit._tag, "OrchestrationReadThreadInputError");
  }).pipe(Effect.provide(Layer.fresh(TestLayer))),
);
