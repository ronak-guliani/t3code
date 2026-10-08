import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import type { WorkLogEntry } from "../../session-logic";
import { deriveTimelineEntries } from "../../session-logic";
import type { ChatMessage } from "../../types";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";

const CREATED_AT = "2026-09-15T12:00:00.000Z";
const WORK_ENTRY_COUNT = 3_000;
const STREAM_CHUNK_COUNT = 40;
const ASSISTANT_CREATED_AT = new Date(Date.parse(CREATED_AT) + WORK_ENTRY_COUNT + 2).toISOString();
const USER_MESSAGE: ChatMessage = {
  id: MessageId.make("benchmark-user-message"),
  role: "user",
  text: "Inspect this workspace.",
  createdAt: CREATED_AT,
  streaming: false,
};
const EMPTY_SUMMARIES = new Map();

function makeWorkEntries(): WorkLogEntry[] {
  return Array.from({ length: WORK_ENTRY_COUNT }, (_, index) => ({
    id: `work-${index}`,
    stableId: `work-${index}`,
    createdAt: new Date(Date.parse(CREATED_AT) + index + 1).toISOString(),
    label: "Read file",
    detail: `src/file-${index}.ts`,
    tone: "tool",
  }));
}

function makeMessages(activeText: string): ChatMessage[] {
  return [
    USER_MESSAGE,
    {
      id: MessageId.make("benchmark-assistant-message"),
      role: "assistant",
      text: activeText,
      createdAt: ASSISTANT_CREATED_AT,
      streaming: true,
    },
  ];
}

describe("timeline streaming benchmark", () => {
  it("reports derivation cost after 3,000 historical tool entries", () => {
    const workEntries = makeWorkEntries();
    let state: StableMessagesTimelineRowsState = { byId: new Map(), result: [] };
    const sample = (activeText: string) => {
      const startedAt = performance.now();
      const timelineEntries = deriveTimelineEntries(makeMessages(activeText), [], workEntries);
      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId: null,
        isWorking: true,
        activeTurnId: null,
        activeTurnStartedAt: CREATED_AT,
        turnDiffSummaryByAssistantMessageId: EMPTY_SUMMARIES,
        revertTurnCountByUserMessageId: EMPTY_SUMMARIES,
        crossThreadSendsBySourceMessageId: EMPTY_SUMMARIES,
      });
      state = computeStableMessagesTimelineRows(rows, state);
      return performance.now() - startedAt;
    };

    for (let index = 0; index < 10; index += 1) {
      sample(`warmup ${index}`);
    }
    const samples = Array.from({ length: STREAM_CHUNK_COUNT }, (_, index) =>
      sample(`stream chunk ${index}`),
    ).toSorted((left, right) => left - right);
    const medianMs = samples[Math.floor(samples.length / 2)] ?? 0;
    const p95Ms = samples[Math.ceil(samples.length * 0.95) - 1] ?? 0;

    console.info(
      JSON.stringify({
        benchmark: "timeline-stream-after-large-tool-group",
        workEntries: WORK_ENTRY_COUNT,
        streamChunks: STREAM_CHUNK_COUNT,
        medianMs: Number(medianMs.toFixed(3)),
        p95Ms: Number(p95Ms.toFixed(3)),
      }),
    );
    expect(state.result.map((row) => row.kind)).toEqual(["message", "work", "message", "working"]);
    expect(state.result[0]?.kind === "message" && state.result[0].message.id).toBe(USER_MESSAGE.id);
    expect(state.result[1]?.kind === "work" && state.result[1].groupedEntries).toHaveLength(
      WORK_ENTRY_COUNT,
    );
  });
});
