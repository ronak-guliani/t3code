import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );

  it.effect("returns the newest user message timestamp without fetching rows", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-latest-user-message-at");

      assert.strictEqual(yield* repository.getLatestUserMessageAt({ threadId }), null);

      yield* repository.upsert({
        messageId: MessageId.make("message-latest-user-assistant"),
        threadId,
        turnId: null,
        role: "assistant",
        text: "newer but not a user message",
        isStreaming: false,
        createdAt: "2026-03-02T00:00:03.000Z",
        updatedAt: "2026-03-02T00:00:03.000Z",
      });
      yield* repository.upsert({
        messageId: MessageId.make("message-latest-user-older"),
        threadId,
        turnId: null,
        role: "user",
        text: "older",
        isStreaming: false,
        createdAt: "2026-03-02T00:00:01.000Z",
        updatedAt: "2026-03-02T00:00:01.000Z",
      });
      yield* repository.upsert({
        messageId: MessageId.make("message-latest-user-newer"),
        threadId,
        turnId: null,
        role: "user",
        text: "newer",
        isStreaming: false,
        createdAt: "2026-03-02T00:00:02.000Z",
        updatedAt: "2026-03-02T00:00:02.000Z",
      });

      assert.strictEqual(
        yield* repository.getLatestUserMessageAt({ threadId }),
        "2026-03-02T00:00:02.000Z",
      );
    }),
  );

  it.effect("persists cross-thread provenance across later message updates", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-cross-thread");
      const messageId = MessageId.make("message-cross-thread");
      const origin = {
        kind: "cross-thread" as const,
        sourceThreadId: ThreadId.make("thread-source"),
        sourceMessageId: MessageId.make("message-source"),
        sourceThreadTitle: "Source thread",
      };
      const createdAt = "2026-03-01T00:00:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        origin,
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });
      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-03-01T00:00:01.000Z",
      });

      const message = yield* repository.getByMessageId({ messageId });
      assert.equal(message._tag, "Some");
      if (message._tag === "Some") {
        assert.deepEqual(message.value.origin, origin);
      }
    }),
  );

  it.effect("lists revert keys and attachment refs without message payloads", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-revert-keys");
      const turnId = TurnId.make("turn-revert-keys");
      const attachments = [
        {
          type: "image" as const,
          id: "thread-revert-keys-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId: MessageId.make("message-revert-keys-1"),
        threadId,
        turnId,
        role: "user",
        text: "first",
        attachments,
        isStreaming: false,
        createdAt: "2026-03-03T00:00:01.000Z",
        updatedAt: "2026-03-03T00:00:01.000Z",
      });
      yield* repository.upsert({
        messageId: MessageId.make("message-revert-keys-2"),
        threadId,
        turnId: null,
        role: "assistant",
        text: "second",
        isStreaming: false,
        createdAt: "2026-03-03T00:00:02.000Z",
        updatedAt: "2026-03-03T00:00:02.000Z",
      });

      const keys = yield* repository.listRevertKeysByThreadId({ threadId });
      assert.deepStrictEqual(
        keys.map((key) => key.messageId),
        ["message-revert-keys-1", "message-revert-keys-2"],
      );
      assert.strictEqual(keys[0]?.turnId, turnId);
      assert.strictEqual(keys[0]?.role, "user");
      for (const key of keys) {
        assert.notProperty(key, "text");
        assert.notProperty(key, "attachments");
        assert.notProperty(key, "origin");
      }

      const refs = yield* repository.listAttachmentRefsByThreadId({ threadId });
      assert.strictEqual(refs.length, 2);
      assert.deepEqual(refs[0]?.attachments, attachments);
      assert.strictEqual(refs[1]?.attachments, null);
      for (const ref of refs) {
        assert.notProperty(ref, "text");
        assert.notProperty(ref, "origin");
      }
    }),
  );

  it.effect("deletes only the listed messages by id", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-delete-by-ids");
      const keptId = MessageId.make("message-delete-by-ids-kept");
      const trimmedId = MessageId.make("message-delete-by-ids-trimmed");

      yield* repository.upsert({
        messageId: keptId,
        threadId,
        turnId: null,
        role: "user",
        text: "kept",
        isStreaming: false,
        createdAt: "2026-03-04T00:00:01.000Z",
        updatedAt: "2026-03-04T00:00:01.000Z",
      });
      yield* repository.upsert({
        messageId: trimmedId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "trimmed",
        isStreaming: false,
        createdAt: "2026-03-04T00:00:02.000Z",
        updatedAt: "2026-03-04T00:00:02.000Z",
      });

      yield* repository.deleteByMessageIds({ threadId, messageIds: [] });
      assert.strictEqual((yield* repository.listByThreadId({ threadId })).length, 2);

      yield* repository.deleteByMessageIds({ threadId, messageIds: [trimmedId] });
      const rows = yield* repository.listByThreadId({ threadId });
      assert.deepStrictEqual(
        rows.map((row) => row.messageId),
        [keptId],
      );
      assert.strictEqual(rows[0]?.text, "kept");
    }),
  );
});
