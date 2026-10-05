import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  OrchestrationSubscribeThreadInput,
  OrchestrationGetThreadActivitiesInput,
} from "./orchestration.ts";
import { ThreadId } from "./baseSchemas.ts";

// An explicit historical page cannot be silently satisfied by resume-only
// events; turnLimit alone is a snapshot-fallback size. Activity head reads
// should not need fabricated timestamps or IDs; cursor fields form one pair.
describe("history protocol input", () => {
  it("rejects resume combined with a historical page selector", () => {
    const threadId = ThreadId.make("thread");
    expect(
      Schema.decodeUnknownExit(OrchestrationSubscribeThreadInput)({
        threadId,
        beforeCursor: "older",
        aroundMessageId: "message",
      })._tag,
    ).toBe("Failure");
    for (const window of [{ beforeCursor: "older" }, { aroundMessageId: "message" }])
      expect(
        Schema.decodeUnknownExit(OrchestrationSubscribeThreadInput)({
          threadId,
          afterSequence: 1,
          ...window,
        })._tag,
      ).toBe("Failure");
    expect(
      Schema.decodeUnknownExit(OrchestrationSubscribeThreadInput)({
        threadId,
        afterSequence: 1,
        turnLimit: 10,
      })._tag,
    ).toBe("Success");
  });
  it("accepts a genuine activity-head read and rejects half a cursor", () => {
    const threadId = ThreadId.make("thread");
    const decode = Schema.decodeUnknownExit(OrchestrationGetThreadActivitiesInput);
    expect(decode({ threadId, limit: 200 })._tag).toBe("Success");
    expect(decode({ threadId, beforeCreatedAt: "2026-01-01T00:00:00.000Z", limit: 200 })._tag).toBe(
      "Failure",
    );
    expect(decode({ threadId, beforeActivityId: "activity", limit: 200 })._tag).toBe("Failure");
    expect(
      decode({
        threadId,
        beforeCreatedAt: "2026-01-01T00:00:00.000Z",
        beforeActivityId: "activity",
        limit: 200,
      })._tag,
    ).toBe("Success");
  });
});
