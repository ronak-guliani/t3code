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
  it("keeps same-timestamp lifecycle siblings in canonical order across a merge", () => {
    // The live reducer orders same-timestamp activities by lifecycle rank, so
    // task.started precedes task.completed even though "completed" sorts first
    // lexicographically. A merge must not invert that.
    const at = "2026-10-04T00:00:00.000Z";
    const older = { messages: [], activities: [], proposedPlans: [], checkpoints: [] };
    const loaded = {
      messages: [],
      activities: [
        { id: "task-completed", kind: "task.completed", createdAt: at },
        { id: "task-started", kind: "task.started", createdAt: at },
      ],
      proposedPlans: [],
      checkpoints: [],
    };
    const merged = History.mergeHistoryCollections(older, loaded);
    expect(merged.activities.map((row) => row.id)).toEqual(["task-started", "task-completed"]);
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
    const tiedAt = "2026-10-04T00:00:00.000Z";
    const older = {
      messages: Array.from({ length: 20 }, (_, i) => ({
        id: `m${i + 71}`,
        role: "user",
        createdAt: tiedAt,
      })),
      activities: [],
      proposedPlans: [],
      checkpoints: [],
    };
    const loaded = {
      messages: [
        { id: "m5", role: "user", createdAt: tiedAt },
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `m${i + 91}`,
          role: "user",
          createdAt: tiedAt,
        })),
      ],
      activities: [],
      proposedPlans: [],
      checkpoints: [],
    };
    const merged = History.mergeHistoryCollections(older, loaded, {
      older: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`m${i + 71}`, { sequence: i + 71, rowId: i + 71 }]),
      ),
      loaded: Object.fromEntries([
        ["m5", { sequence: 5, rowId: 5 }],
        ...Array.from({ length: 10 }, (_, i) => [
          `m${i + 91}`,
          { sequence: i + 91, rowId: i + 91 },
        ]),
      ]),
    });
    expect(merged.messages.map((message) => message.id)).toEqual([
      "m5",
      ...Array.from({ length: 30 }, (_, i) => `m${i + 71}`),
    ]);
  });

  it("merges clock-skewed and legacy-null message origins by sequence and rowid", () => {
    const older = {
      messages: [
        { id: "legacy-5", role: "user", createdAt: "2099-01-01T00:00:00.000Z", text: "old" },
        { id: "seq-10", role: "user", createdAt: "2098-01-01T00:00:00.000Z" },
        { id: "seq-20", role: "user", createdAt: "2097-01-01T00:00:00.000Z", text: "stale" },
        { id: "seq-30", role: "user", createdAt: "2096-01-01T00:00:00.000Z" },
      ],
      activities: [],
      proposedPlans: [],
      checkpoints: [],
    };
    const loaded = {
      messages: [
        { id: "legacy-2", role: "user", createdAt: "1900-01-01T00:00:00.000Z" },
        { id: "seq-20", role: "user", createdAt: "1800-01-01T00:00:00.000Z", text: "live" },
      ],
      activities: [],
      proposedPlans: [],
      checkpoints: [],
    };
    const merged = History.mergeHistoryCollections(older, loaded, {
      older: {
        "legacy-5": { sequence: null, rowId: 5 },
        "seq-10": { sequence: 10, rowId: 10 },
        "seq-20": { sequence: 20, rowId: 20 },
        "seq-30": { sequence: 30, rowId: 30 },
      },
      loaded: {
        "legacy-2": { sequence: null, rowId: 2 },
        "seq-20": { sequence: 20, rowId: 20 },
      },
    });
    expect(merged.messages.map((message) => message.id)).toEqual([
      "legacy-2",
      "legacy-5",
      "seq-10",
      "seq-20",
      "seq-30",
    ]);
    expect(merged.messages.find((message) => message.id === "seq-20")?.text).toBe("live");
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
