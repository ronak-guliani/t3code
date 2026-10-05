import { describe, expect, it } from "vitest";
import * as History from "./threadHistory.ts";
import {
  encodeThreadHistoryCursor,
  historyCursorAfterTrim,
  isHistoryCursorExpired,
} from "./threadHistoryState.ts";

// Failure modes: human copy is mistaken for a typed expiry; wrapped/cyclic
// errors hide reasons; a no-op trim fabricates older history; missing user
// provenance disables exclusion; duplicate IDs or differently ordered pages
// lose live values; server/browser cursor encodings drift on Unicode.
describe("history helper invariants", () => {
  it("encodes stable same-thread navigation data including Unicode", () => {
    const encoded = encodeThreadHistoryCursor("thread-Δ", "message-🙂");
    expect(encoded).not.toMatch(/[+/=]/);
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual({
      version: 1,
      threadId: "thread-Δ",
      messageId: "message-🙂",
    });
  });
  it("uses typed expiry reasons independently of reworded human messages", () => {
    expect(
      isHistoryCursorExpired({ reason: "history-cursor-stale", message: "Please refresh" }),
    ).toBe(true);
    expect(
      isHistoryCursorExpired({ cause: { reason: "history-cursor-stale", message: "日本語" } }),
    ).toBe(true);
    expect(isHistoryCursorExpired({ message: "History changed; reload this thread" })).toBe(false);
    expect(
      isHistoryCursorExpired({ reason: "other", message: "History changed; reload this thread" }),
    ).toBe(false);
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(isHistoryCursorExpired(cycle)).toBe(false);
  });
  it("reopens history only after real eviction with a known retained boundary", () => {
    const page = {
      beforeCursor: null,
      hasMore: false,
      windowStart: null,
      userOrigins: { old: { sequence: 1, rowId: 1 }, keep: { sequence: 2, rowId: 2 } },
    };
    const rows = [
      { id: "keep", role: "user" },
      { id: "reply", role: "assistant" },
    ];
    expect(historyCursorAfterTrim(page, "thread", rows, 0)).toBe(page);
    const result = historyCursorAfterTrim(page, "thread", rows, 1)!;
    expect(result.hasMore).toBe(true);
    expect(result.windowStart).toEqual({ sequence: 2, rowId: 2 });
    expect(result.userOrigins).toEqual({ keep: { sequence: 2, rowId: 2 } });
    expect(result.beforeCursor).toBe(encodeThreadHistoryCursor("thread", "keep"));
  });
  it("requests an authoritative boundary instead of failing open when provenance is absent", () => {
    const page = {
      beforeCursor: "old",
      hasMore: true,
      windowStart: { sequence: 1, rowId: 1 },
      userOrigins: {},
    };
    expect(historyCursorAfterTrim(page, "thread", [{ id: "missing", role: "user" }], 1)).toBeNull();
    expect(
      historyCursorAfterTrim(page, "thread", [{ id: "assistant", role: "assistant" }], 1),
    ).toBeNull();
  });
  it("deduplicates older rows as well as live overlaps without mutating inputs", () => {
    const older = [
        { id: "a", value: 1 },
        { id: "a", value: 2 },
        { id: "b", value: 1 },
      ],
      loaded = [{ id: "b", value: 3 }];
    expect(History.prependHistoryRows(older, loaded, (r) => r.id)).toEqual([
      { id: "a", value: 1 },
      { id: "b", value: 3 },
    ]);
    expect(older).toHaveLength(3);
    expect(loaded).toHaveLength(1);
  });
  it("shares deterministic collection ordering and live-overlap precedence", () => {
    const older = {
      messages: [{ id: "old", createdAt: "2020" }],
      activities: [
        { id: "b", createdAt: "2021" },
        { id: "a", createdAt: "2020" },
      ],
      proposedPlans: [
        { id: "p2", createdAt: "2021" },
        { id: "p1", createdAt: "2020" },
      ],
      checkpoints: [
        { turnId: "t2", checkpointTurnCount: 2 },
        { turnId: "t1", checkpointTurnCount: 1 },
      ],
    };
    const loaded = {
      messages: [{ id: "new", createdAt: "2022" }],
      activities: [{ id: "b", createdAt: "2021", live: true }],
      proposedPlans: [{ id: "p3", createdAt: "2022" }],
      checkpoints: [{ turnId: "t3", checkpointTurnCount: 3 }],
    };
    const merged = History.mergeHistoryCollections(older, loaded);
    expect(merged.messages.map((r) => r.id)).toEqual(["old", "new"]);
    expect(merged.activities.map((r) => r.id)).toEqual(["a", "b"]);
    expect(merged.activities[1]).toMatchObject({ live: true });
    expect(merged.proposedPlans.map((r) => r.id)).toEqual(["p1", "p2", "p3"]);
    expect(merged.checkpoints.map((r) => r.turnId)).toEqual(["t1", "t2", "t3"]);
  });

  it("inserts an older page before an around-window without moving the live overlap", () => {
    const merged = History.mergeHistoryCollections(
      {
        messages: Array.from({ length: 20 }, (_, i) => ({
          id: `m${i + 71}`,
          createdAt: String(i + 71).padStart(3, "0"),
        })),
        activities: [],
        proposedPlans: [],
        checkpoints: [],
      },
      {
        messages: [
          { id: "m5", createdAt: "005" },
          ...Array.from({ length: 10 }, (_, i) => ({
            id: `m${i + 91}`,
            createdAt: String(i + 91).padStart(3, "0"),
          })),
        ],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
      },
    );
    expect(merged.messages.map((message) => message.id)).toEqual([
      "m5",
      ...Array.from({ length: 30 }, (_, i) => `m${i + 71}`),
    ]);
  });

  it("keeps unknown checkpoint turns after known turns", () => {
    const merged = History.mergeHistoryCollections(
      {
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [{ turnId: "unknown" }, { turnId: "known", checkpointTurnCount: 2 }],
      },
      { messages: [], activities: [], proposedPlans: [], checkpoints: [] },
    );
    expect(merged.checkpoints.map((checkpoint) => checkpoint.turnId)).toEqual(["known", "unknown"]);
  });
});
