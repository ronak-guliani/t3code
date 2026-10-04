import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
